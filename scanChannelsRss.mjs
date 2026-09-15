import fs from 'fs';
import path from 'path';
import Parser from 'rss-parser';
import { google } from 'googleapis';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { YOUTUBE_API_KEY } from './config.mjs'; // 👈 Импортируем ключ из config.mjs
import {
  HOUR_MS,
  METRICS_HISTORY_LIMIT,
  appendMetricsHistory,
  gainOverWindow,
  computeHourlyRate,
  isBoom,
  mergeHistories,
  hasPointOlderThan
} from './metrics.mjs';

const parser = new Parser();

const CHANNELS_FILE = path.resolve('channels.json');
const SHORTS_FILE = path.resolve('viral_shorts_results.json');
const QUOTA_FILE = path.resolve('quota.json');

// TTL кэша метрик (мс). Видео, проверенные недавно, не перезапрашиваем через API.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

// Настройка прокси (если требуется)
const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

const youtube = google.youtube({
  version: 'v3',
  auth: YOUTUBE_API_KEY,
  agent: agent || undefined
});

// Утилита списания квоты (1 unit = 1 API-запрос)
// Формат даты ДОЛЖЕН совпадать с server.mjs (toLocaleDateString 'en-US', America/Los_Angeles)
function getQuotaDate() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
}

function trackApiCost(cost = 0) {
  if (cost <= 0) return;
  try {
    let quotaData = { used: 0, lastReset: getQuotaDate() };
    if (fs.existsSync(QUOTA_FILE)) {
      try {
        quotaData = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
      } catch (e) {}
    }

    const today = getQuotaDate();
    if (quotaData.lastReset !== today) {
      quotaData.used = 0;
      quotaData.lastReset = today;
    }

    quotaData.used = (quotaData.used || 0) + cost;
    quotaData.lastScanCost = cost;
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotaData, null, 2), 'utf-8');
  } catch (e) {
    console.error('⚠️ Ошибка обновления quota.json:', e.message);
  }
}

async function mapConcurrent(items, limit, fn) {
  const results = [];
  const executing = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

// In-memory кэш результатов проверки isShort (не дёргаем HEAD повторно в одном прогоне)
const checkIfShortCache = new Map(); // videoId -> boolean

/**
 * Быстрая проверка: является ли видео Shorts (по заголовкам редиректа)
 */
async function checkIfShort(videoId) {
  if (checkIfShortCache.has(videoId)) return checkIfShortCache.get(videoId);
  try {
    const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      redirect: 'manual'
    });
    // Если статус 200 — это однозначно Shorts. 303/302 означает редирект на обычное видео /watch
    const isShort = res.status === 200;
    checkIfShortCache.set(videoId, isShort);
    return isShort;
  } catch (e) {
    checkIfShortCache.set(videoId, false);
    return false;
  }
}

/**
 * Пакетное получение деталей просмотров через YouTube API.
 * @param {string[]} videoIds - ID видео для проверки
 * @param {boolean} deep - если true, всегда спрашиваем API; иначе используем кэш, где возможно
 * @param {Map<string, {views:number, lastCheckedAt:number}>} existingCache - известные метрики из базы
 * @returns {Promise<{map: Map, cost: number, fromCache: number}>}
 */
async function fetchVideoDetailsBatch(videoIds, deep = false, existingCache = new Map()) {
  if (!videoIds || videoIds.length === 0) return { map: new Map(), cost: 0, fromCache: 0 };

  const detailsMap = new Map();
  const now = Date.now();
  let cost = 0;
  let fromCache = 0;

  // 1) Сначала пробуем взять из кэша (если не deep и кэш свежий)
  const toFetch = [];
  if (!deep) {
    for (const id of videoIds) {
      const cached = existingCache.get(id);
      if (cached && cached.views !== undefined && (now - (cached.lastCheckedAt || 0)) < CACHE_TTL_MS) {
        detailsMap.set(id, { views: cached.views, duration: cached.duration, fromCache: true });
        fromCache++;
      } else {
        toFetch.push(id);
      }
    }
  } else {
    toFetch.push(...videoIds);
  }

  // 2) Остальное — пакетами по 50
  for (let i = 0; i < toFetch.length; i += 50) {
    const chunk = toFetch.slice(i, i + 50);
    cost++; // 1 запрос = 1 unit
    try {
      const res = await youtube.videos.list({
        part: ['statistics', 'snippet', 'contentDetails'],
        id: chunk.join(',')
      });

      for (const item of res.data.items || []) {
        detailsMap.set(item.id, {
          views: parseInt(item.statistics.viewCount || '0', 10),
          duration: item.contentDetails.duration,
          lastCheckedAt: now,
          fromCache: false
        });
      }
    } catch (err) {
      console.error('⚠️ Ошибка при пакетном API запросе видео:', err.message);
    }
  }

  return { map: detailsMap, cost, fromCache };
}

// ─── ЧЕСТНЫЕ МЕТРИКИ: история просмотров ───────────────────────────────────────
// Реализация — в ./metrics.mjs (общий модуль). Здесь только тонкие обёртки.

/**
 * Функция очистки массива от дублей по ID (оставляет элемент с максимальными просмотрами)
 */
function deduplicateVideos(videosArray) {
  if (!Array.isArray(videosArray)) return [];
  
  const map = new Map();
  for (const item of videosArray) {
    if (!item || !item.id) continue;
    
    if (!map.has(item.id)) {
      map.set(item.id, item);
    } else {
      const existing = map.get(item.id);
      // Оставляем вариант с большим количеством просмотров
      if ((item.views || 0) >= (existing.views || 0)) {
        const mergedDedup = mergeHistories(existing.metricsHistory, item.metricsHistory);
        const nowMs = Date.now();
        map.set(item.id, {
          ...existing,
          ...item,
          prevViews: existing.views || item.prevViews || 0,
          views: Math.max(item.views || 0, existing.views || 0),
          metricsHistory: mergedDedup.length >= 2
            ? mergedDedup
            : (existing.metricsHistory || item.metricsHistory || [{ t: nowMs, views: Math.max(item.views || 0, existing.views || 0) }])
        });
      }
    }
  }
  return Array.from(map.values());
}

export async function scanChannelsRss(targetNiche = null, targetChannelId = null, options = {}) {
  console.log('🚀 Запуск молниеносного RSS-сканирования (RSS + API Batch)...');
  const DEEP = options.deep === true || options.mode === 'deep';
  console.log(`🎚 Режим: ${DEEP ? 'DEEP (полная перепроверка метрик через API)' : 'FAST (кэш + минимум API)'}`);

  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ Файл channels.json не найден!');
    return { message: 'Файл channels.json не найден' };
  }

  let channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
  let shortsData = { videos: [], updatedAt: new Date().toISOString() };

  if (fs.existsSync(SHORTS_FILE)) {
    try {
      shortsData = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf8'));
      if (!Array.isArray(shortsData.videos)) {
        shortsData.videos = [];
      }
    } catch (e) {
      shortsData.videos = [];
    }
  }

  // 1. Предварительно схлопываем существующие дубликаты из базы
  shortsData.videos = deduplicateVideos(shortsData.videos);

  const existingVideosMap = new Map();
  (shortsData.videos || []).forEach(v => existingVideosMap.set(v.id, v));

  let targetChannels = channels;
  if (targetChannelId && targetChannelId.includes(',')) {
    // Массовое сканирование нескольких каналов (IDs через запятую)
    const idsSet = new Set(targetChannelId.split(',').map(s => s.trim()).filter(Boolean));
    targetChannels = channels.filter(c => idsSet.has(c.channelId));
  } else if (targetChannelId) {
    targetChannels = channels.filter(c => c.channelId === targetChannelId);
  } else if (targetNiche && targetNiche !== 'ALL' && targetNiche !== 'undefined') {
    targetChannels = channels.filter(c => c.niche === targetNiche);
  }

  // Опция "--all": сканирование всех каналов. По умолчанию — только включённые (enabled),
  // если includeDisabled=true — буквально все (включая отключённые)
  if (options.all === true) {
    targetChannels = options.includeDisabled === true
      ? channels
      : channels.filter(c => c.enabled !== false);
  }

  console.log(`📌 Отобрано каналов для сканирования: ${targetChannels.length} из ${channels.length}`);

  const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const candidateItems = [];

  // 1. БЫСТРЫЙ СБОР XML СО ВСЕХ КАНАЛОВ
  await mapConcurrent(targetChannels, 15, async (channel) => {
    try {
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;
      const res = await fetch(rssUrl);
      if (!res.ok) return;

      const xmlText = await res.text();
      const feed = await parser.parseString(xmlText);
      if (!feed.items || feed.items.length === 0) return;

      channel.lastRssCheck = new Date().toISOString();
      const recentItems = feed.items.slice(0, 10);

      for (const item of recentItems) {
        const videoId = item.id ? item.id.replace('yt:video:', '') : null;
        if (!videoId) continue;

        const pubDate = new Date(item.pubDate || item.isoDate).getTime();
        if ((now - pubDate) > ONE_MONTH_MS) continue; // Старее 30 дней — пропускаем

        candidateItems.push({
          videoId,
          title: item.title,
          publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
          channel
        });
      }
    } catch (e) {}
  });

  console.log(`🔎 Собрано ${candidateItems.length} кандидатов из RSS. Проверяем на Shorts...`);

  // Дедупликация кандидатов по videoId (один ролик может встречаться в RSS нескольких каналов)
  const seenVideoIds = new Set();
  const uniqueCandidates = [];
  for (const item of candidateItems) {
    if (seenVideoIds.has(item.videoId)) continue;
    seenVideoIds.add(item.videoId);
    uniqueCandidates.push(item);
  }
  if (uniqueCandidates.length < candidateItems.length) {
    console.log(`🧹 Убрано дубликатов videoId: ${candidateItems.length - uniqueCandidates.length}`);
  }

  // 2. БЫСТРАЯ ФИЛЬТРАЦИЯ ТОЛЬКО SHORTS (Параллельная проверка HEAD-запросом)
  const shortsCandidates = [];
  // Повышаем параллельность HEAD: YouTube обычно выдерживает до ~60-80 одновременных соединений.
  // При ~1.5-2с на видео это ускоряет этап в 2-3 раза по сравнению с лимитом 20.
  const HEAD_CONCURRENCY = 60;
  await mapConcurrent(uniqueCandidates, HEAD_CONCURRENCY, async (item) => {
    // Для видео, которое уже известно в базе как Shorts (свежий lastCheckAt), пропускаем HEAD:
    // мы и так знаем его статус — не тратим лишний сетевой запрос.
    const known = existingVideosMap.get(item.videoId);
    if (known && known.isShort !== false) {
      shortsCandidates.push({ ...item, fromCache: true });
      return;
    }
    const isShort = await checkIfShort(item.videoId);
    if (isShort) {
      shortsCandidates.push(item);
    }
  });

  console.log(`🎯 Отфильтровано Shorts за месяц: ${shortsCandidates.length}. Запрашиваем метрики...`);

  // 3. ПАКЕТНОЕ ПОЛУЧЕНИЕ ПРОСМОТРОВ ЧЕРЕЗ API (с кэшем для fast-режима)
  const allShortsIds = shortsCandidates.map(c => c.videoId);

  // Строим кэш из уже известных видео (в viral_shorts_results.json)
  const existingCache = new Map();
  for (const v of (shortsData.videos || [])) {
    if (v && v.id) {
      existingCache.set(v.id, {
        views: v.views,
        duration: v.duration,
        lastCheckedAt: v.lastCheckAt ? new Date(v.lastCheckAt).getTime() : 0
      });
    }
  }

  const { map: videoDetailsMap, cost: apiCost, fromCache: cacheHits } = await fetchVideoDetailsBatch(allShortsIds, DEEP, existingCache);

  // Списываем квоту: каждый пакет по 50 видео = 1 unit API
  if (apiCost > 0) {
    trackApiCost(apiCost);
    console.log(`💵 Списано квоты: +${apiCost} unit (${apiCost} пакетов по 50 видео), из кэша взято: ${cacheHits}`);
  } else {
    console.log(`💵 Квоты не потрачено (все ${cacheHits} роликов взято из кэша)`);
  }

  // Группировка Shorts по каналам
  const channelShortsMap = new Map();
  for (const item of shortsCandidates) {
    const details = videoDetailsMap.get(item.videoId);
    if (!details) continue;

    const fullItem = { ...item, views: details.views };
    if (!channelShortsMap.has(item.channel.channelId)) {
      channelShortsMap.set(item.channel.channelId, []);
    }
    channelShortsMap.get(item.channel.channelId).push(fullItem);
  }

  let newShortsCount = 0;
  let updatedShortsCount = 0;
  let skippedInactiveChannels = 0;

  // 4. РАСЧЕТ СРЕДНИХ ПОКАЗАТЕЛЕЙ И ОБНОВЛЕНИЕ БАЗЫ
  for (const channel of targetChannels) {
    const channelShorts = channelShortsMap.get(channel.channelId) || [];

    if (channelShorts.length === 0) {
      channel.channelAverageViews = 0;
      channel.inactive = true;
      skippedInactiveChannels++;
      continue;
    }

    // Расчет среднего только по Shorts за последний месяц
    const totalViews = channelShorts.reduce((sum, v) => sum + v.views, 0);
    const newAvgViews = Math.round(totalViews / channelShorts.length);
    channel.channelAverageViews = newAvgViews;
    channel.inactive = false;

    for (const videoInfo of channelShorts) {
      const existingVideo = existingVideosMap.get(videoInfo.videoId);
      const outlierRatio = parseFloat((videoInfo.views / (newAvgViews || 1)).toFixed(2));

      const pubDate = new Date(videoInfo.publishedAt);
      const daysOld = Math.max(1, (now - pubDate.getTime()) / (1000 * 60 * 60 * 24));
      const viewsPerDay = Math.round(videoInfo.views / daysOld);

      if (existingVideo) {
        // ОБНОВЛЕНИЕ СУЩЕСТВУЮЩЕГО ВИДЕО
        const oldViews = existingVideo.views || 0;
        const hist = appendMetricsHistory(existingVideo, now, videoInfo.views);
        const gain24h = gainOverWindow(hist, now, 24 * HOUR_MS);
        const hourlyRate = computeHourlyRate(hist, now);
        // BOOM — если прирост за сутки ≥50% текущих просмотров ИЛИ темп > 20%/час
        const boom = isBoom(hist, now, videoInfo.views, gain24h, hourlyRate);
        // Если в истории нет точки старше 24ч — знаем, что накопили недостаточно
        const gainUnknown = !hasPointOlderThan(hist, now, 24 * HOUR_MS);

        existingVideo.metricsHistory = hist;
        existingVideo.prevViews = oldViews;
        existingVideo.views = videoInfo.views;
        existingVideo.views24hGain = gain24h;
        existingVideo.hourlyRate = hourlyRate;
        existingVideo.boom = boom;
        existingVideo.gain24hUnknown = gainUnknown;
        if (!gainUnknown) existingVideo.gain24hUnknown = false;

        // Пересчитываем viewsPerDay по 24ч-приросту (датчик «скорости»)
        const gpd = gain24h > 0 ? Math.round(gain24h / 24) : 0;
        existingVideo.viewsPerDay = gpd > 0 ? gpd : viewsPerDay;
        existingVideo.outlierRatio = outlierRatio;
        existingVideo.channelAverageViews = newAvgViews;
        existingVideo.lastCheckAt = new Date().toISOString();

        updatedShortsCount++;
      } else if (outlierRatio >= 1.2) {
        // Проверяем, не было ли видео случайно добавлено в массив ранее во время этой же итерации
        const alreadyInArrayIdx = shortsData.videos.findIndex(v => v.id === videoInfo.videoId);

        if (alreadyInArrayIdx === -1) {
          // ДОБАВЛЕНИЕ НОВОГО ВИДЕО
          const nowIso = new Date().toISOString();
          const newVideo = {
            id: videoInfo.videoId,
            title: videoInfo.title,
            url: `https://www.youtube.com/watch?v=${videoInfo.videoId}`,
            thumbnail: `https://i.ytimg.com/vi/${videoInfo.videoId}/hqdefault.jpg`,
            views: videoInfo.views,
            prevViews: videoInfo.views,
            metricsHistory: [{ t: now, views: videoInfo.views }],
            views24hGain: 0,
            hourlyRate: 0,
            boom: false,
            gain24hUnknown: true,
            viewsPerDay: viewsPerDay,
            publishedAt: videoInfo.publishedAt,
            channelTitle: channel.channelTitle,
            channelId: channel.channelId,
            channelAverageViews: newAvgViews,
            avgViews: newAvgViews,
            outlierRatio: outlierRatio,
            niche: channel.niche,
            foundVia: 'RSS',
            isNew: true,
            addedAt: nowIso,
            lastCheckAt: nowIso
          };

          shortsData.videos.push(newVideo);
          existingVideosMap.set(videoInfo.videoId, newVideo);
          newShortsCount++;
        }
      }
    }
  }

  // Финальная дедупликация перед сохранением для гарантированной чистоты файла
  shortsData.videos = deduplicateVideos(shortsData.videos);
  shortsData.videos.sort((a, b) => b.outlierRatio - a.outlierRatio);
  shortsData.totalShortsCount = shortsData.videos.length;
  shortsData.updatedAt = new Date().toISOString();

  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf8');
  fs.writeFileSync(SHORTS_FILE, JSON.stringify(shortsData, null, 2), 'utf8');

  const resultMsg = `Сканирование завершено. Добавлено новых: ${newShortsCount}, обновлено: ${updatedShortsCount}, отброшено каналов без Shorts: ${skippedInactiveChannels}`;
  console.log('✅ ' + resultMsg);

  return { message: resultMsg, newCount: newShortsCount, updatedCount: updatedShortsCount, inactiveCount: skippedInactiveChannels };
}

// Прямой запуск
if (process.argv[1] && process.argv[1].endsWith('scanChannelsRss.mjs')) {
  const args = process.argv.slice(2);
  let channelIds = [];
  let niche = null;
  let all = false;
  let includeDisabled = false;
  let deep = false;

  args.forEach(arg => {
    if (arg.startsWith('--channelId=') || arg.startsWith('--channelIds=')) {
      const raw = arg.split('=')[1].replace(/^["']|["']$/g, '');
      raw.split(',').map(s => s.trim()).filter(Boolean).forEach(id => channelIds.push(id));
    }
    if (arg.startsWith('--niche=')) {
      niche = arg.split('=')[1].replace(/^["']|["']$/g, '');
    }
    if (arg.startsWith('--all=')) {
      all = arg.split('=')[1].toLowerCase() === 'true';
    }
    if (arg.startsWith('--includeDisabled=')) {
      includeDisabled = arg.split('=')[1].toLowerCase() === 'true';
    }
    if (arg.startsWith('--deep=')) {
      deep = arg.split('=')[1].toLowerCase() === 'true';
    }
  });

  // Массовое сканирование — передаём массив каналов (join через запятую)
  const finalChannelId = channelIds.length > 0 ? channelIds.join(',') : null;
  scanChannelsRss(niche, finalChannelId, { all, includeDisabled, deep });
}