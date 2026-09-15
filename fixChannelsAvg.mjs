import { google } from 'googleapis';
import fs from 'fs';
import { YOUTUBE_API_KEY } from './config.mjs';

const youtube = google.youtube({
  version: 'v3',
  auth: YOUTUBE_API_KEY
});

const CHANNELS_FILE = './channels.json';

async function getChannelAverageViews(channelId) {
  try {
    const channelRes = await youtube.channels.list({
      part: 'contentDetails',
      id: channelId
    });

    const uploadsPlaylistId = channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) return 0;

    const playlistRes = await youtube.playlistItems.list({
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 15
    });

    const videoIds = playlistRes.data.items.map(item => item.contentDetails.videoId);
    if (videoIds.length === 0) return 0;

    const statsRes = await youtube.videos.list({
      part: 'statistics',
      id: videoIds.join(',')
    });

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

async function fixAllChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ Файл channels.json не найден');
    return;
  }

  const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
  console.log(`📌 Загружено каналов: ${channels.length}`);

  let updatedCount = 0;

  // Обрабатываем пачками по 10 параллельно, чтобы не перегрузить сеть
  const BATCH_SIZE = 10;
  for (let i = 0; i < channels.length; i += BATCH_SIZE) {
    const batch = channels.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (ch) => {
      // Обновляем, если просмотры равны 0 или отсутствуют
      if (!ch.channelAverageViews || ch.channelAverageViews === 0) {
        const avg = await getChannelAverageViews(ch.channelId);
        if (avg > 0) {
          ch.channelAverageViews = avg;
          updatedCount++;
        } else {
          // Если у канала нет роликов или произошел сбой, ставим дефолтное безопасное значение
          ch.channelAverageViews = 5000;
        }
      }
    }));

    console.log(`⏳ Прогресс: ${Math.min(i + BATCH_SIZE, channels.length)} / ${channels.length}...`);
  }

  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf-8');
  console.log(`\n✅ Готово! Обновлено каналов со значениием 0: ${updatedCount}`);
}

fixAllChannels().catch(console.error);