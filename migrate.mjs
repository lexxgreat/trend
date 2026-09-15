// migrate.mjs — однократная миграция данных для честных метрик и чистки мусора.
// Запуск: node migrate.mjs
// Делает бэкап изменяемых файлов в _backup/ перед записью.

import fs from 'fs';
import path from 'path';
import {
  HOUR_MS,
  gainOverWindow,
  computeHourlyRate,
  isBoom,
  mergeHistories
} from './metrics.mjs';

const FILES = ['viral_shorts_results.json', 'channels.json', 'niches.json'];
const BACKUP_DIR = path.resolve('_backup');

function backup() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const done = [];
  for (const f of FILES) {
    if (fs.existsSync(f)) {
      const dest = path.join(BACKUP_DIR, `${stamp}__${f}`);
      fs.copyFileSync(f, dest);
      done.push(dest);
    }
  }
  console.log(`💾 Бэкап создан: ${done.length} файлов → _backup/`);
  return done;
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.error(`⚠️ Ошибка чтения ${file}:`, e.message);
  }
  return fallback;
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── 1. Миграция viral_shorts_results.json ────────────────────────────────────
function migrateShortsResults(now) {
  const data = loadJson('viral_shorts_results.json', { videos: [] });
  let changed = 0;
  let deduped = 0;

  for (let i = 0; i < data.videos.length; i++) {
    const v = data.videos[i];
    if (!v || !v.id) continue;

    const hasHist = Array.isArray(v.metricsHistory) && v.metricsHistory.length > 0;
    // Кеш lastCheckAt → точка истории, если реальной истории ещё нет
    if (!hasHist && v.lastCheckAt) {
      const t = new Date(v.lastCheckAt).getTime();
      if (Number.isFinite(t) && t > 0) {
        v.metricsHistory = [{ t, views: v.views || 0 }];
        v.hourlyRate = 0;
        v.boom = false;
        // Не знаем реального прироста за сутки → честно помечаем неизвестным
        v.gain24hUnknown = true;
        v.views24hGain = 0;
        changed++;
      }
    }
  }

  // Дедупликация с сохранением объединённой истории
  const map = new Map();
  for (const v of data.videos) {
    if (!v || !v.id) continue;
    if (!map.has(v.id)) {
      map.set(v.id, v);
    } else {
      const existing = map.get(v.id);
      const merged = mergeHistories(existing.metricsHistory, v.metricsHistory);
      const maxViews = Math.max(existing.views || 0, v.views || 0);
      map.set(v.id, {
        ...existing,
        ...v,
        views: maxViews,
        prevViews: Math.min(existing.views || 0, v.views || 0) || existing.prevViews || 0,
        metricsHistory: merged.length >= 2
          ? merged
          : (existing.metricsHistory || v.metricsHistory || [{ t: now, views: maxViews }]),
        views24hGain: gainOverWindow(merged, now, 24 * HOUR_MS) || existing.views24hGain || 0,
        hourlyRate: computeHourlyRate(merged, now) || existing.hourlyRate || 0,
        boom: isBoom(merged, now, maxViews)
      });
      deduped++;
    }
  }

  data.videos = Array.from(map.values());
  // Пересчитываем 24ч-прирост для тех, у кого история есть (им уже не unknown)
  for (const v of data.videos) {
    if (Array.isArray(v.metricsHistory) && v.metricsHistory.length >= 2) {
      v.views24hGain = gainOverWindow(v.metricsHistory, now, 24 * HOUR_MS);
      v.hourlyRate = computeHourlyRate(v.metricsHistory, now);
      v.boom = isBoom(v.metricsHistory, now, v.views || 0);
      v.gain24hUnknown = false;
    }
  }

  data.totalShortsCount = data.videos.length;
  data.updatedAt = new Date().toISOString();
  saveJson('viral_shorts_results.json', data);
  console.log(`📺 viral_shorts_results.json: сгенерирована история для ${changed} роликов, схлопнуто дублей: ${deduped}, всего роликов: ${data.videos.length}`);
}

// ─── 2. Чистка ниш и каналов ──────────────────────────────────────────────────
function migrateNichesAndChannels() {
  let niches = loadJson('niches.json', []);
  const channels = loadJson('channels.json', []);
  let channelNicheRenames = 0;

  // «Стройка» → «Строительство» (слияние)
  const stroyka = niches.find(n => n.name.trim().toLowerCase() === 'стройка');
  const stroitelstvo = niches.find(n => n.name.trim().toLowerCase() === 'строительство');
  if (stroyka && stroitelstvo) {
    // Объединяем ключевые слова
    const keys = new Set(stroitelstvo.keywords.map(k => k.trim().toLowerCase()));
    for (const k of stroyka.keywords || []) {
      if (k.trim() && !keys.has(k.trim().toLowerCase())) stroitelstvo.keywords.push(k.trim());
    }
    niches = niches.filter(n => n !== stroyka);
    // Каналы «Стройка» переходят в «Строительство»
    for (const ch of channels) {
      if ((ch.niche || '').trim().toLowerCase() === 'стройка') {
        ch.niche = stroitelstvo.name;
        channelNicheRenames++;
      }
    }
    console.log(`🔀 «Стройка» → «${stroitelstvo.name}»: каналов перенесено: ${channelNicheRenames}`);
  }

  // «Nfyws» (опечатка) → disabled
  const nfyws = niches.find(n => n.name.trim().toLowerCase() === 'nfyws');
  if (nfyws) {
    nfyws.enabled = false;
    console.log(`🔇 Ниша «${nfyws.name}» отключена (опечатка)`);
  }

  // Каналы «Такси» — убеждаемся что ниша есть
  const taxis = channels.filter(ch => (ch.niche || '').trim().toLowerCase() === 'такси');
  if (taxis.length > 0 && !niches.some(n => n.name.trim().toLowerCase() === 'такси')) {
    niches.push({ name: 'Такси', enabled: true, keywords: ['такси', 'таксопарк'] });
    console.log(`🚕 Ниша «Такси» добавлена в niches.json (${taxis.length} каналов)`);
  }

  saveJson('niches.json', niches);
  saveJson('channels.json', channels);
  console.log(`🏷️ Ниш: ${niches.length}, каналов: ${channels.length}`);
}

// ─── 3. Подборки из «Такси» ───────────────────────────────────────────────────
function createCollectionsFromTaxi() {
  const collectionsFile = 'collections.json';
  if (fs.existsSync(collectionsFile)) {
    console.log('📁 collections.json уже существует — пропускаем создание.');
    return;
  }

  const channels = loadJson('channels.json', []);
  const taxiChannels = channels.filter(ch => (ch.niche || '').trim().toLowerCase() === 'такси');
  if (taxiChannels.length === 0) {
    console.log('📁 Каналов «Такси» не найдено — подборка не создана.');
    return;
  }

  const collection = {
    id: 'taxi',
    name: 'Такси',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    channelIds: taxiChannels.map(c => c.channelId),
    description: 'Автоматически создана из ниши «Такси» при миграции'
  };

  saveJson(collectionsFile, { collections: [collection] });
  console.log(`📁 Подборка «${collection.name}» создана: ${collection.channelIds.length} каналов → collections.json`);
}

function main() {
  const now = Date.now();
  console.log('🔄 Начинаю миграцию данных...\n');
  backup();
  migrateShortsResults(now);
  migrateNichesAndChannels();
  createCollectionsFromTaxi();
  console.log('\n✅ Миграция завершена. Проверьте _backup/ для отката.');
}

main();