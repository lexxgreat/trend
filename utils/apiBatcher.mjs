import { google } from 'googleapis';

/**
 * Запрашивает статистику для массива ID видео за один API-запрос (до 50 штук)
 * @param {Array<string>} videoIds - Массив ID видео
 * @param {string} apiKey - API ключ YouTube
 */
export async function fetchVideosBatch(videoIds, apiKey) {
  if (!videoIds || videoIds.length === 0) return [];

  const youtube = google.youtube({
    version: 'v3',
    auth: apiKey
  });

  // YouTube API принимает до 50 ID через запятую
  const chunks = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    chunks.push(videoIds.slice(i, i + 50));
  }

  const allStats = [];

  for (const chunk of chunks) {
    const res = await youtube.videos.list({
      part: ['statistics', 'snippet'],
      id: chunk
    });

    if (res.data.items) {
      for (const item of res.data.items) {
        allStats.push({
          id: item.id,
          title: item.snippet.title,
          channelTitle: item.snippet.channelTitle,
          publishedAt: item.snippet.publishedAt,
          views: parseInt(item.statistics.viewCount || 0, 10),
          likes: parseInt(item.statistics.likeCount || 0, 10),
          comments: parseInt(item.statistics.commentCount || 0, 10)
        });
      }
    }
  }

  return allStats;
}