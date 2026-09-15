import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { YOUTUBE_API_KEY } from './config.mjs';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const QUOTA_LIMIT = 10000;
const QUOTA_FILE = 'quota.json';
const CHANNELS_FILE = 'channels.json';
const SHORTS_FILE = 'viral_shorts_results.json';
const COLLECTIONS_FILE = 'collections.json';
const COLLECTION_RESULTS_PREFIX = 'collection_results_';

function getYTDateString() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' });
}

function getQuotaData() {
  const currentDate = getYTDateString();
  let quota = { used: 0, lastReset: currentDate };

  if (fs.existsSync(QUOTA_FILE)) {
    try {
      quota = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf-8'));
    } catch (err) {}
  }

  if (quota.lastReset !== currentDate) {
    quota.used = 0;
    quota.lastReset = currentDate;
    saveQuotaData(quota);
  }

  return quota;
}

function saveQuotaData(quota) {
  fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota, null, 2), 'utf-8');
}

function normalizeNicheName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Нечёткий поиск ниш (Левенштейн ≤ 2) ──────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3; // ранний выход — точно больше 2
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,           // delete
        curr[j - 1] + 1,       // insert
        prev[j - 1] + cost     // substitute
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return curr[n];
}

function findBestNicheMatch(inputName, niches) {
  const needle = normalizeNicheName(inputName);
  if (!needle) return null;
  // Точное совпадение
  const exact = niches.find(n => normalizeNicheName(n.name) === needle);
  if (exact) return { niche: exact, distance: 0 };
  // Нечёткое: ищем минимальную дистанцию Левенштейна (≤2) по началу строки/полному имени
  let best = null;
  let bestDist = Infinity;
  for (const n of niches) {
    const candidate = normalizeNicheName(n.name);
    const dFull = levenshtein(needle, candidate);
    const dPrefix = levenshtein(needle, candidate.slice(0, Math.min(needle.length, candidate.length)));
    const d = Math.min(dFull, dPrefix);
    if (d <= 2 && d < bestDist) {
      bestDist = d;
      best = { niche: n, distance: d };
    }
  }
  return best;
}

// ─── Подборки: чтение/запись ──────────────────────────────────────────────────
function readCollections() {
  try {
    if (fs.existsSync(COLLECTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(COLLECTIONS_FILE, 'utf-8'));
      if (Array.isArray(data.collections)) return data.collections;
    }
  } catch (e) {}
  return [];
}

function saveCollections(collections) {
  const data = { collections, updatedAt: new Date().toISOString() };
  fs.writeFileSync(COLLECTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function readCollectionResults(id) {
  const file = `${COLLECTION_RESULTS_PREFIX}${id}.json`;
  const fallback = { id, videos: [], updatedAt: null };
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (Array.isArray(data.videos)) return data;
    }
  } catch (e) {}
  return fallback;
}

function saveCollectionResults(id, results) {
  const file = `${COLLECTION_RESULTS_PREFIX}${id}.json`;
  fs.writeFileSync(file, JSON.stringify({ ...results, id, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

// 1. Получение квоты
app.get('/api/quota', (req, res) => {
  const quota = getQuotaData();
  res.json({
    used: quota.used,
    limit: QUOTA_LIMIT,
    remaining: Math.max(0, QUOTA_LIMIT - quota.used)
  });
});

// 2. Список каналов из базы
app.get('/api/channels', (req, res) => {
  if (fs.existsSync(CHANNELS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
      return res.json(data);
    } catch (e) {}
  }
  res.json([]);
});

// 2.1. Обновление канала (смена ниши)
app.put('/api/channels/:channelId', (req, res) => {
  try {
    const { channelId } = req.params;
    const { niche } = req.body || {};
    if (niche === undefined && req.body && Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Не указано новое значение ниши.' });
    }
    if (!fs.existsSync(CHANNELS_FILE)) {
      return res.status(404).json({ error: 'База каналов пуста.' });
    }
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    const ch = channels.find(c => c.channelId === channelId);
    if (!ch) return res.status(404).json({ error: 'Канал не найден в базе.' });
    const oldNiche = ch.niche || '';
    ch.niche = String(niche ?? '').trim();
    ch.updatedAt = new Date().toISOString();
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf-8');

    // Обновляем нишу у видео этого канала в основных результатах
    if (fs.existsSync(SHORTS_FILE)) {
      try {
        const shorts = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf-8'));
        if (shorts && Array.isArray(shorts.videos)) {
          let changed = false;
          shorts.videos.forEach(v => {
            if (v.channelId === channelId) {
              v.niche = ch.niche;
              changed = true;
            }
          });
          if (changed) {
            shorts.updatedAt = new Date().toISOString();
            fs.writeFileSync(SHORTS_FILE, JSON.stringify(shorts, null, 2), 'utf-8');
          }
        }
      } catch (e) {}
    }

    res.json({ success: true, channel: { channelId, channelTitle: ch.channelTitle, niche: ch.niche, oldNiche } });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления канала', details: err.message });
  }
});

// 3. POST /api/search-channels — Выделенный поиск каналов по API
app.post('/api/search-channels', async (req, res) => {
  const { nicheName, keywords } = req.body;

  if (!nicheName || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'Укажите нишу и ключевые слова для поиска каналов.' });
  }

  const quota = getQuotaData();
  let addedCount = 0;

  try {
    let existingChannels = [];
    if (fs.existsSync(CHANNELS_FILE)) {
      try {
        existingChannels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
      } catch (e) {}
    }

    const channelMap = new Map(existingChannels.map(c => [c.channelId, c]));

    for (const keyword of keywords) {
      if (!keyword.trim()) continue;

      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=15&q=${encodeURIComponent(keyword.trim())}&key=${YOUTUBE_API_KEY}`;
      quota.used += 100;

      const response = await fetch(url);
      const data = await response.json();

      if (data.items) {
        for (const item of data.items) {
          const chId = item.snippet.channelId || item.id.channelId;
          if (chId && !channelMap.has(chId)) {
            channelMap.set(chId, {
              channelId: chId,
              channelTitle: item.snippet.channelTitle || item.snippet.title,
              niche: nicheName.trim(),
              channelAverageViews: 0,
              enabled: true,
              addedAt: new Date().toISOString()
            });
            addedCount++;
          }
        }
      }
    }

    const updatedChannelsList = Array.from(channelMap.values());
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(updatedChannelsList, null, 2), 'utf-8');
    saveQuotaData(quota);

    // Запуск обогащения с трансляцией логов в терминал
    console.log('⚡ Запуск фонового обогащения каналов...');
    const enrichChild = spawn('node', ['enrichChannels.mjs'], { stdio: 'inherit' });
    enrichChild.on('close', (code) => {
      if (code === 0) console.log('✅ Новые каналы успешно обогащены метриками!');
      else console.error(`⚠️ Обогащение каналов завершилось с кодом: ${code}`);
    });

    res.json({
      success: true,
      message: `Найдено и добавлено новых каналов: ${addedCount}`,
      addedCount
    });

  } catch (error) {
    console.error('Ошибка поиска каналов:', error);
    res.status(500).json({ error: 'Ошибка сервера при поиске каналов', details: error.message });
  }
});

// 4. POST /api/scan-rss
app.post('/api/scan-rss', (req, res) => {
  const { niche, channelId, all, forceAll, channelIds, mode, collectionId } = req.body || {};
  // mode: 'fast' (кэш, минимум API) | 'deep' (полная перепроверка всех видео через API) | undefined (как раньше)
  const scanMode = (mode === 'deep' || mode === 'fast') ? mode : 'fast';
  
  const args = ['scanChannelsRss.mjs'];
  let collectionName = null;
  if (collectionId) {
    // Сканирование каналов из подборки
    const collections = readCollections();
    const col = collections.find(c => c.id === collectionId);
    if (col) {
      collectionName = col.name;
      const validChannelIds = (col.channelIds || []).filter(Boolean).slice(0, 200);
      validChannelIds.forEach(id => args.push(`--channelId=${id}`));
      if (validChannelIds.length === 0) {
        return res.status(400).json({ error: `В подборке "${col.name}" нет каналов.` });
      }
    }
  } else if (Array.isArray(channelIds) && channelIds.length > 0) {
    // Массовое сканирование выбранных каналов
    channelIds.filter(Boolean).slice(0, 200).forEach(id => args.push(`--channelId=${id}`));
  } else if (channelId) {
    args.push(`--channelId=${channelId}`);
  } else if (all === true) {
    // Все каналы (по умолчанию — только enabled; forceAll — буквально все)
    args.push('--all=true');
    if (forceAll === true) args.push('--includeDisabled=true');
  } else if (niche && niche !== 'ALL') {
    args.push(`--niche=${niche}`);
  }

  if (scanMode === 'deep') args.push('--deep=true');
  // Если сканирование "глубокое", считаем, что оно может стоить до N units (пакеты видео) — 
  // точную цену знает сам скрипт; здесь мы лишь передаём флаг без списания.

  console.log(`\n⚡ [SERVER] Запуск RSS-сканирования (${scanMode}${collectionName ? `, подборка: "${collectionName}"` : ''}): node ${args.join(' ')}`);

  const child = spawn('node', args, { stdio: 'inherit' });

  child.on('close', (code) => {
    console.log(`🏁 [SERVER] RSS-сканирование завершено с кодом: ${code}`);
    if (code === 0) {
      // Если сканировали подборку — сохраняем снимок результатов в её файл
      if (collectionId && collectionName) {
        try {
          const allShorts = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf-8'));
          const col = readCollections().find(c => c.id === collectionId);
          const colChannels = new Set(col ? (col.channelIds || []) : []);
          const filtered = (allShorts.videos || []).filter(v => colChannels.has(v.channelId));
          const existingResults = readCollectionResults(collectionId);
          saveCollectionResults(collectionId, {
            ...existingResults,
            videos: filtered,
            collectionName,
            totalShortsCount: filtered.length
          });
          console.log(`📁 Результаты подборки "${collectionName}" сохранены: ${filtered.length} роликов`);
        } catch (snapErr) {
          console.error('⚠️ Ошибка сохранения результатов подборки:', snapErr.message);
        }
      }
      res.json({ success: true, message: 'RSS scanning completed successfully!', mode: scanMode, collectionId });
    } else {
      res.status(500).json({ error: 'Failed to execute RSS scan', code });
    }
  });

  child.on('error', (err) => {
    console.error('❌ Ошибка выполнения RSS сканера:', err.message);
    res.status(500).json({ error: 'Failed to execute RSS scan', details: err.message });
  });
});

// 5. Список ниш
app.get('/api/niches', (req, res) => {
  try {
    if (fs.existsSync('niches.json')) {
      const data = JSON.parse(fs.readFileSync('niches.json', 'utf-8'));
      // Обогащаем количеством каналов и видео по каждой нише
      let channelsData = [];
      let resultsData = { videos: [] };
      try {
        if (fs.existsSync(CHANNELS_FILE)) channelsData = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
        if (fs.existsSync(SHORTS_FILE)) resultsData = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf-8'));
      } catch (e) {}
      const channelCounts = {};
      const videoCounts = {};
      (Array.isArray(channelsData) ? channelsData : []).forEach(c => {
        const k = normalizeNicheName(String(c.niche || ''));
        if (k) channelCounts[k] = (channelCounts[k] || 0) + 1;
      });
      (Array.isArray(resultsData.videos) ? resultsData.videos : []).forEach(v => {
        const k = normalizeNicheName(String(v.niche || ''));
        if (k) videoCounts[k] = (videoCounts[k] || 0) + 1;
      });
      const enriched = (Array.isArray(data) ? data : []).map(n => {
        const chans = (Array.isArray(channelsData) ? channelsData : [])
          .filter(c => normalizeNicheName(String(c.niche || '')) === normalizeNicheName(n.name));
        return {
          ...n,
          channelCount: chans.length,
          videoCount: videoCounts[normalizeNicheName(n.name)] || 0,
          // Список каналов ниши для отображения/редактирования
          channels: chans.map(c => ({
            channelId: c.channelId,
            channelTitle: c.channelTitle,
            subscribers: c.subscribers,
            channelAverageViews: c.channelAverageViews,
            niche: c.niche
          }))
        };
      });
      res.json(enriched);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: 'Ошибка чтения niches.json' });
  }
});

// 6. Результаты поиска
app.get('/api/shorts', (req, res) => {
  const filePath = path.resolve('viral_shorts_results.json');
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Ошибка чтения результатов' });
    }
  } else {
    res.json({ videos: [], updatedAt: null });
  }
});

// 6.5. Подборки (collections)
app.get('/api/collections', (req, res) => {
  try {
    const collections = readCollections();
    // Обогащаем подборки числом каналов/видео для удобного ui
    const channelsData = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')) : [];
    const channelMap = new Map((Array.isArray(channelsData) ? channelsData : []).map(c => [c.channelId, c]));
    const enriched = collections.map(col => {
      const chans = (col.channelIds || []).map(id => channelMap.get(id)).filter(Boolean);
      const results = readCollectionResults(col.id);
      return {
        ...col,
        channelCount: chans.length,
        videoCount: Array.isArray(results.videos) ? results.videos.length : 0,
        lastScanAt: results.updatedAt || null,
        // Обогащаем результаты подборки данными каналов для удобного отображения в карточке
        results: (Array.isArray(results.videos) ? results.videos : []).map(v => {
          const ch = channelMap.get(v.channelId);
          return { ...v, channelTitle: v.channelTitle || ch?.channelTitle || null };
        }),
        channels: chans.map(ch => ({
          channelId: ch.channelId,
          channelTitle: ch.channelTitle,
          niche: ch.niche,
          subscribers: ch.subscribers,
          channelAverageViews: ch.channelAverageViews
        }))
      };
    });
    res.json({ collections: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка чтения подборок', details: err.message });
  }
});

app.post('/api/collections', (req, res) => {
  try {
    const { name, channelIds, description } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Укажите название подборки.' });
    }
    const collections = readCollections();
    const id = 'col_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const collection = {
      id,
      name: String(name).trim(),
      description: description || '',
      channelIds: Array.isArray(channelIds) ? channelIds.filter(Boolean) : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    collections.push(collection);
    saveCollections(collections);
    res.json({ success: true, collection });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания подборки', details: err.message });
  }
});

app.put('/api/collections/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, channelIds, description } = req.body || {};
    const collections = readCollections();
    const col = collections.find(c => c.id === id);
    if (!col) return res.status(404).json({ error: 'Подборка не найдена.' });
    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Название не может быть пустым.' });
      col.name = String(name).trim();
    }
    if (description !== undefined) col.description = String(description);
    if (Array.isArray(channelIds)) col.channelIds = channelIds.filter(Boolean);
    col.updatedAt = new Date().toISOString();
    saveCollections(collections);
    res.json({ success: true, collection: col });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления подборки', details: err.message });
  }
});

// 6.5.1 Добавление каналов в подборку (по ID или по нише)
app.post('/api/collections/:id/channels', (req, res) => {
  try {
    const { id } = req.params;
    const { channelIds, niche } = req.body || {};
    const collections = readCollections();
    const col = collections.find(c => c.id === id);
    if (!col) return res.status(404).json({ error: 'Подборка не найдена.' });

    let toAdd = [];
    if (Array.isArray(channelIds) && channelIds.length) {
      toAdd = channelIds.filter(Boolean);
    } else if (niche && String(niche).trim()) {
      // Добавляем все каналы из указанной ниши
      const channelsData = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')) : [];
      const k = normalizeNicheName(String(niche).trim());
      toAdd = (Array.isArray(channelsData) ? channelsData : [])
        .filter(c => normalizeNicheName(String(c.niche || '')) === k)
        .map(c => c.channelId);
    }

    if (!toAdd.length) {
      return res.status(400).json({ error: 'Не указано, какие каналы добавить (channelIds или niche).' });
    }

    // Проверяем, какие из добавляемых каналов есть в базе (для честного ответа)
    const channelsData = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')) : [];
    const knownIds = new Set((Array.isArray(channelsData) ? channelsData : []).map(c => c.channelId));
    const already = new Set(col.channelIds || []);
    let added = 0;
    let skipped = 0;
    for (const chId of toAdd) {
      if (!chId) continue;
      if (already.has(chId)) { skipped++; continue; }
      col.channelIds.push(chId);
      already.add(chId);
      added++;
    }
    col.updatedAt = new Date().toISOString();
    saveCollections(collections);
    res.json({
      success: true,
      added,
      skipped,
      collectionId: id,
      knownInBase: toAdd.filter(chId => knownIds.has(chId)).length,
      unknownInBase: toAdd.filter(chId => !knownIds.has(chId)).length
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления каналов в подборку', details: err.message });
  }
});

// 6.5.2 Удаление канала из подборки
app.delete('/api/collections/:id/channels/:channelId', (req, res) => {
  try {
    const { id, channelId } = req.params;
    const collections = readCollections();
    const col = collections.find(c => c.id === id);
    if (!col) return res.status(404).json({ error: 'Подборка не найдена.' });
    const before = col.channelIds?.length || 0;
    col.channelIds = (col.channelIds || []).filter(cid => cid !== channelId);
    const removed = before - (col.channelIds?.length || 0);
    col.updatedAt = new Date().toISOString();
    saveCollections(collections);
    res.json({ success: true, removed, collectionId: id });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления канала из подборки', details: err.message });
  }
});

app.delete('/api/collections/:id', (req, res) => {
  try {
    const { id } = req.params;
    let collections = readCollections();
    const existed = collections.some(c => c.id === id);
    collections = collections.filter(c => c.id !== id);
    saveCollections(collections);
    // Удаляем файл результатов подборки (если есть)
    const resultsFile = `${COLLECTION_RESULTS_PREFIX}${id}.json`;
    if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile);
    res.json({ success: true, deleted: existed, id });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления подборки', details: err.message });
  }
});

// Результаты сканирования подборки
app.get('/api/collections/:id/results', (req, res) => {
  const { id } = req.params;
  const results = readCollectionResults(id);
  res.json(results);
});

// 6.6. Нечёткий поиск ниш (для автокомплита/валидации при добавлении)
app.get('/api/niches/search', (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    let niches = [];
    if (fs.existsSync('niches.json')) {
      niches = JSON.parse(fs.readFileSync('niches.json', 'utf-8'));
    }
    const results = niches
      .map(n => {
        const m = findBestNicheMatch(q, [n]);
        return {
          name: n.name,
          enabled: n.enabled,
          distance: m ? m.distance : null,
          fuzzy: m ? m.distance > 0 : false
        };
      })
      .filter(r => r.distance !== null && r.distance <= 2)
      .sort((a, b) => (a.distance || 0) - (b.distance || 0))
      .slice(0, 5);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска ниш', details: err.message });
  }
});

// 6.7. Добавление новой ниши
app.post('/api/niches', (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Укажите название ниши.' });
    }
    let niches = [];
    if (fs.existsSync('niches.json')) {
      niches = JSON.parse(fs.readFileSync('niches.json', 'utf-8'));
    }
    const existing = niches.find(n => normalizeNicheName(n.name) === normalizeNicheName(String(name).trim()));
    if (existing) {
      return res.json({ success: true, name: existing.name, alreadyExists: true });
    }
    const newNiche = { name: String(name).trim(), enabled: false, keywords: [] };
    niches.push(newNiche);
    fs.writeFileSync('niches.json', JSON.stringify(niches, null, 2), 'utf-8');
    res.json({ success: true, name: newNiche.name, alreadyExists: false });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления ниши', details: err.message });
  }
});

// 6.8. Удаление ниши (и связанных каналов/видео)
app.delete('/api/niches', (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите имя ниши для удаления.' });
    let niches = [];
    if (fs.existsSync('niches.json')) {
      niches = JSON.parse(fs.readFileSync('niches.json', 'utf-8'));
    }
    const targetName = normalizeNicheName(String(name).trim());
    const existed = niches.some(n => normalizeNicheName(n.name) === targetName);
    niches = niches.filter(n => normalizeNicheName(n.name) !== targetName);
    fs.writeFileSync('niches.json', JSON.stringify(niches, null, 2), 'utf-8');

    // Удаляем каналы этой ниши из базы каналов
    if (fs.existsSync(CHANNELS_FILE)) {
      try {
        const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
        if (Array.isArray(channels)) {
          const filtered = channels.filter(c => normalizeNicheName(String(c.niche || '')) !== targetName);
          fs.writeFileSync(CHANNELS_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
        }
      } catch (e) {}
    }

    // Удаляем видео этой ниши из результатов
    if (fs.existsSync(SHORTS_FILE)) {
      try {
        const shorts = JSON.parse(fs.readFileSync(SHORTS_FILE, 'utf-8'));
        if (shorts && Array.isArray(shorts.videos)) {
          shorts.videos = shorts.videos.filter(v => normalizeNicheName(String(v.niche || '')) !== targetName);
          shorts.updatedAt = new Date().toISOString();
          fs.writeFileSync(SHORTS_FILE, JSON.stringify(shorts, null, 2), 'utf-8');
        }
      } catch (e) {}
    }

    res.json({ success: true, deleted: existed, name: String(name).trim() });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления ниши', details: err.message });
  }
});

// 6.9. Экспорт подборки в JSON
app.get('/api/collections/:id/export', (req, res) => {
  try {
    const { id } = req.params;
    const collections = readCollections();
    const col = collections.find(c => c.id === id);
    if (!col) return res.status(404).json({ error: 'Подборка не найдена.' });
    const results = readCollectionResults(id);
    const channelsData = fs.existsSync(CHANNELS_FILE) ? JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8')) : [];
    const channelMap = new Map((Array.isArray(channelsData) ? channelsData : []).map(c => [c.channelId, c]));
    const channels = (col.channelIds || []).map(chId => channelMap.get(chId)).filter(Boolean);
    res.json({
      collection: { id: col.id, name: col.name, description: col.description },
      channels,
      videos: Array.isArray(results.videos) ? results.videos : [],
      exportedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка экспорта подборки', details: err.message });
  }
});

// 7. Добавление ниш и запуск API сканирования виралок
app.post('/api/search', (req, res) => {
  const { nicheName, keywords } = req.body;

  if (!nicheName || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'Укажите название ниши и список ключей.' });
  }

  let niches = [];
  try {
    if (fs.existsSync('niches.json')) {
      niches = JSON.parse(fs.readFileSync('niches.json', 'utf-8'));
    }
  } catch (err) {}

  // Нечёткое сопоставление: сначала ищем ТОЧНОЕ, затем fuzzy (Левенштейн ≤ 2)
  let matched = null;
  if (niches.length > 0) {
    const exact = niches.find(n => normalizeNicheName(n.name) === normalizeNicheName(nicheName));
    if (exact) {
      matched = exact;
    } else {
      const fuzzy = findBestNicheMatch(nicheName, niches);
      if (fuzzy) matched = fuzzy.niche;
    }
  }

  let targetNicheName;

  niches.forEach(n => (n.enabled = false));

  if (matched) {
    // Существующая ниша (точная или fuzzy) — используем её название и включаем
    targetNicheName = matched.name;
    matched.enabled = true;
    const existingKeysSet = new Set(matched.keywords.map(k => k.trim().toLowerCase()));
    keywords.forEach(k => {
      const cleanKey = k.trim();
      if (cleanKey && !existingKeysSet.has(cleanKey.toLowerCase())) {
        matched.keywords.push(cleanKey);
        existingKeysSet.add(cleanKey.toLowerCase());
      }
    });
  } else {
    targetNicheName = nicheName.trim();
    const cleanKeywords = Array.from(new Set(keywords.map(k => k.trim()).filter(Boolean)));
    niches.push({ name: targetNicheName, enabled: true, keywords: cleanKeywords });
  }

  fs.writeFileSync('niches.json', JSON.stringify(niches, null, 2), 'utf-8');

  // Учёт квоты
  const quota = getQuotaData();
  const estimatedCost = keywords.length * 105;
  quota.used += estimatedCost;
  saveQuotaData(quota);

  console.log(`\n🚀 [SERVER] Запуск поиска виральных видео по API для ниши: "${targetNicheName}"...`);

  // Запуск с пробросом вывода в консоль
  const child = spawn('node', ['findViralVideos.mjs', targetNicheName], { stdio: 'inherit' });

  child.on('close', (code) => {
    console.log(`🏁 [SERVER] API-поиск завершен с кодом: ${code}`);

    if (code === 0) {
      // Синхронизируем авторов
      syncChannelsFromResults(targetNicheName);

      res.json({ 
        success: true, 
        message: `Ниша "${targetNicheName}" просканирована! Списано ~${estimatedCost} units.`,
        nicheName: targetNicheName
      });
    } else {
      res.status(500).json({ error: 'Ошибка при выполнении сканера API', code });
    }
  });

  child.on('error', (err) => {
    console.error('❌ Ошибка запуска процесса поиска:', err.message);
    res.status(500).json({ error: 'Ошибка при запуске сканера', details: err.message });
  });
});

function syncChannelsFromResults(niche) {
  try {
    if (!fs.existsSync('viral_shorts_results.json')) return;
    const results = JSON.parse(fs.readFileSync('viral_shorts_results.json', 'utf-8'));
    
    let channels = [];
    if (fs.existsSync(CHANNELS_FILE)) {
      channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
    }

    const channelMap = new Map(channels.map(c => [c.channelId, c]));

    for (const v of results.videos || []) {
      if (v.channelId && !channelMap.has(v.channelId)) {
        const newChannel = {
          channelId: v.channelId,
          channelTitle: v.channelTitle || 'Неизвестный канал',
          niche: v.niche || niche,
          channelAverageViews: v.channelAverageViews || v.avgViews || 0,
          enabled: true,
          addedAt: new Date().toISOString()
        };
        channelMap.set(v.channelId, newChannel);
      }
    }

    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(Array.from(channelMap.values()), null, 2), 'utf-8');
  } catch (err) {
    console.error('Ошибка сохранения каналов:', err);
  }
}

app.listen(PORT, () => {
  console.log(`\n🚀 Дашборд запущен на http://localhost:${PORT}`);
});