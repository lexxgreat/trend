import fs from 'fs';

const RESULTS_FILE = 'viral_shorts_results.json';
const CHANNELS_FILE = 'channels.json';

if (fs.existsSync(RESULTS_FILE)) {
  const results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  const channelMap = new Map();

  for (const video of results.videos || []) {
    if (video.channelId && !channelMap.has(video.channelId)) {
      channelMap.set(video.channelId, {
        channelId: video.channelId,
        channelTitle: video.channelTitle || 'Неизвестный канал',
        niche: video.niche || 'General',
        channelAverageViews: video.channelAverageViews || 0,
        enabled: true,
        addedAt: new Date().toISOString()
      });
    }
  }

  const channelsList = Array.from(channelMap.values());
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channelsList, null, 2), 'utf-8');
  console.log(`✅ Файл channels.json успешно создан! Добавлено каналов: ${channelsList.length}`);
} else {
  console.log('⚠️ Файл viral_shorts_results.json не найден. Создан пустой channels.json');
  fs.writeFileSync(CHANNELS_FILE, '[]', 'utf-8');
}