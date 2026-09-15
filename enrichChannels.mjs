import fs from 'fs';
import { google } from 'googleapis';
import { YOUTUBE_API_KEY } from './config.mjs';

const youtube = google.youtube({ version: 'v3', auth: YOUTUBE_API_KEY });
const CHANNELS_FILE = 'channels.json';

async function enrichChannels() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ Файл channels.json не найден!');
    return;
  }

  const rawData = fs.readFileSync(CHANNELS_FILE, 'utf8');
  const channels = JSON.parse(rawData);

  console.log(`🚀 Начинаем обновление ${channels.length} каналов...`);

  // Отправляем пачками по 50 каналов (каждая пачка = 1 unit)
  const chunkSize = 50;
  for (let i = 0; i < channels.length; i += chunkSize) {
    const chunk = channels.slice(i, i + chunkSize);
    const channelIds = chunk.map(c => c.channelId).join(',');

    try {
      const response = await youtube.channels.list({
        part: ['snippet', 'statistics'],
        id: channelIds
      });

      const detailsMap = new Map();
      (response.data.items || []).forEach(item => {
        detailsMap.set(item.id, {
          subscribers: parseInt(item.statistics?.subscriberCount || 0, 10),
          publishedAt: item.snippet?.publishedAt || null
        });
      });

      chunk.forEach(channel => {
        const info = detailsMap.get(channel.channelId);
        if (info) {
          channel.subscribers = info.subscribers;
          channel.publishedAt = info.publishedAt;
        }
      });

      console.log(`✅ Обработано ${Math.min(i + chunkSize, channels.length)} из ${channels.length}`);
    } catch (err) {
      console.error(`❌ Ошибка при запросе:`, err.message);
    }
  }

  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), 'utf8');
  console.log('🎉 `channels.json` успешно обновлен!');
}

enrichChannels();