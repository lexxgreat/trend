import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { YOUTUBE_API_KEY } from './config.mjs';
import {
  HOUR_MS,
  METRICS_HISTORY_LIMIT,
  appendMetricsHistory,
  gainOverWindow,
  computeHourlyRate,
  isBoom,
  mergeHistories
} from './metrics.mjs';

const youtube = google.youtube({
  version: 'v3',
  auth: YOUTUBE_API_KEY
});

// Учет расхода квоты
function trackQuotaSpent(cost) {
  try {
    const quotaPath = path.resolve('./quota.json');
    let quotaData = { usedToday: 0, lastReset: new Date().toISOString().split('T')[0] };
    if (fs.existsSync(quotaPath)) {
      try {
        quotaData = JSON.parse(fs.readFileSync(quotaPath, 'utf-8'));
      } catch (e) {}
    }

    const today = new Date().toISOString().split('T')[0];
    if (quotaData.lastReset !== today) {
      quotaData.usedToday = 0;
      quotaData.lastReset = today;
    }

    quotaData.usedToday += cost;
    fs.writeFileSync(quotaPath, JSON.stringify(quotaData, null, 2), 'utf-8');
  } catch (e) {
    console.error('⚠️ Ошибка обновления quota.json:', e.message);
  }
}

// 1. ЗАГРУЗКА НАСТРОЕК ИЗ NICHES.JSON
let nichesData = [];
try {
  nichesData = JSON.parse(fs.readFileSync('./niches.json', 'utf-8'));
} catch (err) {
  console.error('❌ Ошибка чтения файла niches.json:', err.message);
  process.exit(1);
}

const requestedNicheArg = process.argv[2];
let activeNiche = null;

if (requestedNicheArg) {
  activeNiche = nichesData.find(n => n.name.toLowerCase() === requestedNicheArg.toLowerCase());
}

if (!activeNiche) {
  activeNiche = nichesData.find(n => n.enabled) || nichesData[0];
}

if (!activeNiche) {
  console.error('❌ Не найдена ниша для сканирования');
  process.exit(1);
}

const SHORTS_KEYWORDS = activeNiche.keywords;
const NICHE_NAME = activeNiche.name;

// Настройки фильтрации Shorts
const VIRAL_THRESHOLD = 2.0; // В 2+ раза популярнее нормы канала
const MIN_VIEWS = 5000;      // От 5,000 просмотров
const MAX_DAYS_OLD = 30;     // За последние 30 дней

/**
 * Расчет среднего количества просмотров канала по последним 15 видео
 */
async function getChannelAverageViews(channelId) {
  try {
    const channelRes = await youtube.channels.list({
      part: 'contentDetails',
      id: channelId
    });
    trackQuotaSpent(1);

    const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return 0;

    const playlistRes = await youtube.playlistItems.list({
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 15
    });
    trackQuotaSpent(1);

    const videoIds = playlistRes.data.items.map(item => item.contentDetails.videoId);
    if (videoIds.length === 0) return 0;

    const statsRes = await youtube.videos.list({
      part: 'statistics',
      id: videoIds.join(',')
    });
    trackQuotaSpent(1);

    const validItems = statsRes.data.items.filter(item => parseInt(item.statistics.viewCount || '0', 10) > 0);
    if (validItems.length === 0) return 0;

    const totalViews = validItems.reduce((sum, item) => {
      return sum + parseInt(item.statistics.viewCount || '0', 10);
    }, 0);

    return Math.round(totalViews / validItems.length);
  } catch (error) {
    return 0;
  }
}

/**
 * Детали каналов (подписчики, дата создания)
 */
async function getChannelsDetails(channelIds) {
  const detailsMap = new Map();
  if (!channelIds || channelIds.length === 0) return detailsMap;

  for (let i = 0; i < channelIds.length; i += 50) {
    const chunk = channelIds.slice(i, i + 50);
    try {
      const res = await youtube.channels.list({
        part: ['snippet', 'statistics'],
        id: chunk.join(',')
      });
      trackQuotaSpent(1);

      (res.data.items || []).forEach(item => {
        detailsMap.set(item.id, {
          subscribers: parseInt(item.statistics?.subscriberCount || '0', 10),
          publishedAt: item.snippet?.publishedAt || null
        });
      });
    } catch (err) {
      console.error('⚠️ Ошибка при запросе деталей каналов:', err.message);
    }
  }

  return detailsMap;
}

/**
 * Сохранение каналов
 */
function saveChannelsToDatabase(newChannelsMap) {
  const CHANNELS_FILE = 'channels.json';
  let channels = [];

  if (fs.existsSync(CHANNELS_FILE)) {
    try {
      channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    } catch (err) {}
  }

  const existingMap = new Map(channels.map(c => [c.channelId, c]));
  let addedCount = 0;

  for (const [channelId, info] of newChannelsMap.entries()) {
    if (!existingMap.has(channelId)) {
      existingMap.set(channelId, {
        channelId: channelId,
        channelTitle: info.channelTitle,
        niche: NICHE_NAME,
        channelAverageViews: info.channelAverageViews,
        enabled: true,
        addedAt: new Date().toISOString(),
        lastRssCheck: null,
        subscribers: info.subscribers,
        publishedAt: info.publishedAt
      });
      addedCount++;
    } else {
      const ch = existingMap.get(channelId);
      ch.subscribers = info.subscribers;
      ch.publishedAt = info.publishedAt;
      if (!ch.niche) ch.niche = NICHE_NAME;
    }
  }

  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(Array.from(existingMap.values()), null, 2), 'utf-8');
  if (addedCount > 0) {
    console.log(`📌 В channels.json добавлено новых каналов: ${addedCount}`);
  }
}

// ─── ЧЕСТНЫЕ МЕТРИКИ: история просмотров ───────────────────────────────────────
// Реализация — в ./metrics.mjs (общий модуль). Здесь только тонкие обёртки.

/**
 * Вспомогательная функция полной дедупликации
 */
function deduplicateVideosList(videos) {
  if (!Array.isArray(videos)) return [];
  const map = new Map();

  for (const v of videos) {
    if (!v) continue;
    // Определяем уникальный ключ (id либо из поля id, либо вытягиваем из url)
    let key = v.id;
    if (!key && v.url) {
      const match = v.url.match(/(?:watch\?v=|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (match) key = match[1];
    }
    if (!key) key = v.url;

    if (!map.has(key)) {
      map.set(key, { ...v, id: key });
    } else {
      const existing = map.get(key);
      const maxViews = Math.max(existing.views || 0, v.views || 0);
      const minViews = Math.min(existing.views || 0, v.views || 0);
      const gain = maxViews - minViews;

      // Объединяем истории метрик обоих дублей (общий модуль metrics.mjs)
      const mergedDedup = mergeHistories(existing.metricsHistory, v.metricsHistory);
      const now = Date.now();

      map.set(key, {
        ...existing,
        ...v,
        id: key,
        views: maxViews,
        prevViews: minViews > 0 ? minViews : existing.prevViews || 0,
        metricsHistory: mergedDedup.length >= 2
          ? mergedDedup
          : (existing.metricsHistory || v.metricsHistory || [{ t: now, views: maxViews }]),
        views24hGain: gain > 0 ? gain : (existing.views24hGain || 0),
        hourlyRate: computeHourlyRate(mergedDedup, now) || existing.hourlyRate || 0
      });
    }
  }

  return Array.from(map.values());
}

/**
 * Сохранение результатов с защитой от дублирования
 */
function saveShortsResults(newVideos) {
  const outputFile = 'viral_shorts_results.json';
  let database = {
    updatedAt: new Date().toISOString(),
    niche: NICHE_NAME,
    totalShortsCount: 0,
    videos: []
  };

  if (fs.existsSync(outputFile)) {
    try {
      database = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      if (!Array.isArray(database.videos)) {
        database.videos = [];
      }
    } catch (err) {}
  }

  // Сначала объединяем и очищаем существующие ролики
  let combinedVideos = deduplicateVideosList(database.videos);

  const videoMap = new Map();
  combinedVideos.forEach(v => videoMap.set(v.id, v));

  // Добавляем или обновляем свеженайденные видео
  const nowMs = Date.now();
  newVideos.forEach(newVid => {
    const existing = videoMap.get(newVid.id);
    if (existing) {
      const oldViews = existing.views || 0;
      const nowIso = new Date().toISOString();
      // Честные метрики: пишем срез в историю и считаем 24ч-прирост по времени
      const hist = appendMetricsHistory(existing, nowMs, newVid.views);
      const gain24h = gainOverWindow(hist, nowMs, 24 * HOUR_MS);
      const hourlyRate = computeHourlyRate(hist, nowMs);
      const boom = gain24h >= 0.5 * (newVid.views || 1)
        || hourlyRate >= 0.2 * (newVid.views || 1);

      videoMap.set(newVid.id, {
        ...existing,
        ...newVid,
        prevViews: oldViews,
        views: newVid.views,
        metricsHistory: hist,
        views24hGain: gain24h,
        hourlyRate: hourlyRate,
        boom: boom,
        gain24hUnknown: false,
        lastCheckAt: nowIso
      });
    } else {
      // Новое видео — стартуем с одной точкой истории
      videoMap.set(newVid.id, {
        ...newVid,
        metricsHistory: [{ t: nowMs, views: newVid.views }],
        views24hGain: 0,
        hourlyRate: 0,
        boom: false,
        gain24hUnknown: true,
        lastCheckAt: new Date().toISOString()
      });
    }
  });

  const finalVideos = deduplicateVideosList(Array.from(videoMap.values()));
  finalVideos.sort((a, b) => b.outlierRatio - a.outlierRatio);

  database.updatedAt = new Date().toISOString();
  database.niche = NICHE_NAME;
  database.videos = finalVideos;
  database.totalShortsCount = finalVideos.length;

  fs.writeFileSync(outputFile, JSON.stringify(database, null, 2), 'utf-8');
  console.log(`\n💾 База SHORTS обновлена! Всего уникальных роликов: ${database.totalShortsCount}`);
}

/**
 * Проверка, является ли видео Shorts по длительности (до 60 секунд = PT1M0S)
 */
function isShortsDuration(durationStr) {
  if (!durationStr) return true;
  const matchM = durationStr.match(/(\d+)M/);
  const matchH = durationStr.match(/(\d+)H/);
  if (matchH) return false;
  if (matchM && parseInt(matchM[1], 10) >= 1) {
    if (durationStr === 'PT1M' || durationStr === 'PT1M0S') return true;
    return false;
  }
  return true;
}

/**
 * Главная функция
 */
export async function findViralShorts() {
  console.log(`\n🎯 Активная ниша: "${NICHE_NAME}"`);
  console.log(`🔑 Ключевые слова: ${SHORTS_KEYWORDS.join(', ')}`);

  const publishedAfter = new Date(Date.now() - MAX_DAYS_OLD * 24 * 60 * 60 * 1000).toISOString();
  const processedVideoIds = new Set();
  const rawVideos = [];

  for (const query of SHORTS_KEYWORDS) {
    const cleanQuery = query.trim();
    console.log(`🔎 Поиск в YouTube API: "${cleanQuery}" (videoDuration: short)...`);
    
    try {
      const searchRes = await youtube.search.list({
        part: 'snippet',
        q: cleanQuery,
        type: 'video',
        videoDuration: 'short', // 👈 Используем системную фильтрацию коротких видео YouTube API
        order: 'viewCount',
        publishedAfter: publishedAfter,
        maxResults: 25
      });
      trackQuotaSpent(100);

      for (const item of searchRes.data.items || []) {
        if (item.id?.videoId && !processedVideoIds.has(item.id.videoId)) {
          processedVideoIds.add(item.id.videoId);
          rawVideos.push(item);
        }
      }
    } catch (err) {
      console.error(`⚠️ Ошибка при запросе "${cleanQuery}":`, err.message);
    }
  }

  if (rawVideos.length === 0) {
    console.log('❌ По заданным ключам ничего не найдено.');
    return [];
  }

  console.log(`\n📊 Получено ${rawVideos.length} роликов. Анализируем параметры и длительность...`);

  const videoIdsList = rawVideos.map(v => v.id.videoId);
  const videoStatsMap = new Map();

  for (let i = 0; i < videoIdsList.length; i += 50) {
    const chunk = videoIdsList.slice(i, i + 50);
    const statsRes = await youtube.videos.list({
      part: 'statistics,snippet,contentDetails',
      id: chunk.join(',')
    });
    trackQuotaSpent(1);

    for (const item of statsRes.data.items || []) {
      videoStatsMap.set(item.id, item);
    }
  }

  const uniqueChannelIds = [...new Set(Array.from(videoStatsMap.values()).map(v => v.snippet.channelId))];
  
  console.log(`⚡ Параллельный расчет средних просмотров для ${uniqueChannelIds.length} каналов...`);
  
  const [channelsDetailsMap, channelAvgPairs] = await Promise.all([
    getChannelsDetails(uniqueChannelIds),
    Promise.all(uniqueChannelIds.map(async (id) => {
      const avg = await getChannelAverageViews(id);
      return [id, avg];
    }))
  ]);

  const channelAvgCache = new Map(channelAvgPairs);

  const viralShorts = [];
  const channelsToSave = new Map();

  for (const rawVid of rawVideos) {
    const videoData = videoStatsMap.get(rawVid.id.videoId);
    if (!videoData) continue;

    // Фильтр по длительности (только Shorts до 60 секунд)
    const duration = videoData.contentDetails?.duration;
    if (!isShortsDuration(duration)) continue;

    const views = parseInt(videoData.statistics.viewCount || '0', 10);
    if (views < MIN_VIEWS) continue;

    const channelId = videoData.snippet.channelId;
    let avgViews = channelAvgCache.get(channelId) || 0;

    let ratio = 0;
    if (avgViews > 0) {
      ratio = parseFloat((views / avgViews).toFixed(2));
    } else {
      if (views >= 10000) {
        avgViews = Math.round(views / 2);
        ratio = 2.0;
      }
    }

    if (ratio >= VIRAL_THRESHOLD) {
      const channelDetails = channelsDetailsMap.get(channelId) || { subscribers: 0, publishedAt: null };
      const thumbs = videoData.snippet.thumbnails;
      const thumbnailUrl = thumbs?.maxres?.url || thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || '';

      viralShorts.push({
        id: videoData.id,
        niche: NICHE_NAME,
        format: 'Shorts',
        title: videoData.snippet.title,
        channelTitle: videoData.snippet.channelTitle,
        channelId: channelId,
        views: views,
        avgViews: avgViews,
        channelAverageViews: avgViews,
        subscribers: channelDetails.subscribers,
        channelPublishedAt: channelDetails.publishedAt,
        outlierRatio: ratio,
        url: `https://www.youtube.com/watch?v=${videoData.id}`,
        thumbnail: thumbnailUrl,
        publishedAt: videoData.snippet.publishedAt,
        metricsHistory: [{ t: Date.now(), views }],
        views24hGain: 0,
        hourlyRate: 0,
        boom: false,
        gain24hUnknown: true,
        foundVia: 'API',
        isNew: true,
        addedAt: new Date().toISOString(),
        lastCheckAt: new Date().toISOString()
      });

      channelsToSave.set(channelId, {
        channelTitle: videoData.snippet.channelTitle,
        channelAverageViews: avgViews,
        subscribers: channelDetails.subscribers,
        publishedAt: channelDetails.publishedAt
      });
    }
  }

  viralShorts.sort((a, b) => b.outlierRatio - a.outlierRatio);

  console.log(`\n🔥 НАЙДЕНО ВИРАЛЬНЫХ SHORTS: ${viralShorts.length}\n`);
  viralShorts.forEach((vid, index) => {
    console.log(`${index + 1}. [${vid.outlierRatio}x] ${vid.title}`);
    console.log(`   Канал: ${vid.channelTitle} (${vid.views.toLocaleString()} просмотров)`);
    console.log(`   Ссылка: ${vid.url}\n`);
  });

  if (viralShorts.length > 0) {
    saveShortsResults(viralShorts);
    saveChannelsToDatabase(channelsToSave);
  } else {
    console.log('❌ В этом прогоне новых виральных Shorts не обнаружено.');
  }

  return viralShorts;
}

// Запуск напрямую через CLI
if (process.argv[1] && process.argv[1].endsWith('findViralVideos.mjs')) {
  findViralShorts().catch(console.error);
}