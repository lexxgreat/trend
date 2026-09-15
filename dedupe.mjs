import fs from 'fs/promises';

async function cleanupDuplicates() {
  try {
    const filePath = './viral_shorts_results.json'; // укажите точный путь к вашему JSON
    const fileData = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(fileData);

    if (!data.videos || !Array.isArray(data.videos)) {
      console.log('Массив videos не найден');
      return;
    }

    const uniqueVideosMap = new Map();

    // Проходим по всем видео. При наличии дубля сохраняем тот,
    // у которого больше просмотров (самый свежий замер)
    for (const video of data.videos) {
      const existing = uniqueVideosMap.get(video.id);

      if (!existing) {
        uniqueVideosMap.set(video.id, video);
      } else {
        // Рассчитываем реальный прирост 24ч перед схлопыванием дублей
        const maxViews = Math.max(existing.views || 0, video.views || 0);
        const minViews = Math.min(existing.views || 0, video.views || 0);
        const gain = maxViews - minViews;

        // Обновляем запись свежими данными
        const updatedVideo = (video.views >= existing.views) ? video : existing;
        updatedVideo.views = maxViews;
        updatedVideo.prevViews = minViews;
        if (gain > 0) {
          updatedVideo.views24hGain = gain;
        }

        uniqueVideosMap.set(video.id, updatedVideo);
      }
    }

    data.videos = Array.from(uniqueVideosMap.values());

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ Очистка завершена! Осталось уникальных роликов: ${data.videos.length}`);
  } catch (err) {
    console.error('Ошибка при очистке дублей:', err);
  }
}

cleanupDuplicates();