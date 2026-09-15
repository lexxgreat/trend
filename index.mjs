import fs from 'fs/promises';
import Parser from 'rss-parser';
import { fetchVideosBatch } from './utils/apiBatcher.mjs';
import { filterOutliers } from './utils/trendAnalyzer.mjs';
import { YOUTUBE_API_KEY } from './config.mjs';

const parser = new Parser();

async function runRadar() {
  console.log('🚀 Запуск YouTube Trend Radar...\n');

  try {
    // 1. Загружаем базу каналов
    const channelsData = JSON.parse(await fs.readFile('./data/channels.json', 'utf-8'));
    
    const videosToFetch = [];
    const channelAvgMap = {};

    // 2. Сканируем RSS всех каналов (0 квоты)
    for (const nicheItem of channelsData) {
      console.log(`📂 Ниша: ${nicheItem.niche}`);

      for (const channel of nicheItem.channels) {
        try {
          const feed = await parser.parseURL(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`);
          
          if (feed.items && feed.items.length > 0) {
            // Берем 3 последних видео из RSS
            const recentItems = feed.items.slice(0, 3);

            for (const item of recentItems) {
              const videoId = item.id.split(':')[2];
              videosToFetch.push(videoId);

              // Запоминаем средние просмотры канала для этого видео
              channelAvgMap[videoId] = {
                avgViews: channel.avgViews,
                niche: nicheItem.niche
              };
            }
          }
        } catch (e) {
          console.error(`⚠️ Ошибка чтения RSS канала ${channel.name}: ${e.message}`);
        }
      }
    }

    console.log(`\n🔍 Собрано ${videosToFetch.length} видео из RSS. Запрашиваем точную статистику через Batch API...`);

    // 3. Делаем 1 пакетный запрос к API (1 единица квоты на 50 видео)
    const rawStats = await fetchVideosBatch(videosToFetch, YOUTUBE_API_KEY);

    // 4. Обогащаем данные средними просмотрами
    const enrichedVideos = rawStats.map((video) => ({
      ...video,
      avgViews: channelAvgMap[video.id]?.avgViews || 0,
      niche: channelAvgMap[video.id]?.niche || 'Unknown'
    }));

    // 5. Ищем вирусные видео (порог от 1.5x для теста)
    const viralVideos = filterOutliers(enrichedVideos, 1.5);

    console.log(`\n🔥 НАЙДЕНО ВЫСТРЕЛИВШИХ ВИДЕО: ${viralVideos.length}\n`);

    viralVideos.forEach((v) => {
      console.log(`[${v.niche}] ${v.channelTitle}`);
      console.log(`📹 Название: ${v.title}`);
      console.log(`📈 Просмотры: ${v.views.toLocaleString()} (Средние: ${v.avgViews.toLocaleString()})`);
      console.log(`⚡ Коэффициент аномальности: ${v.outlierRatio}x`);
      console.log(`🔗 https://www.youtube.com/watch?v=${v.id}\n`);
    });

    // Сохраняем результат в trends.json
    await fs.writeFile('./data/trends.json', JSON.stringify(viralVideos, null, 2));
    console.log('💾 Результаты сохранены в data/trends.json');

  } catch (err) {
    console.error('Ошибка исполнения:', err);
  }
}

runRadar();