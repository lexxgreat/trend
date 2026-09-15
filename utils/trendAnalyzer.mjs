/**
 * Вычисляет коэффициент аномальности (Outlier Ratio).
 * @param {number} currentViews — текущие просмотры видео
 * @param {number} avgViews — средние просмотры канала
 * @returns {number}
 */
export function calculateOutlierRatio(currentViews, avgViews) {
  if (!avgViews || avgViews === 0) return 0;
  const ratio = currentViews / avgViews;
  return Number(ratio.toFixed(2));
}

/**
 * Фильтрует видео, оставляя только "выстрелившие"
 * @param {Array} videosStats — список видео со статистикой
 * @param {number} threshold — порог аномальности (по умолчанию 2.5x)
 */
export function filterOutliers(videosStats, threshold = 2.5) {
  return videosStats
    .map((video) => {
      const ratio = calculateOutlierRatio(video.views, video.avgViews);
      return {
        ...video,
        outlierRatio: ratio,
        isViral: ratio >= threshold
      };
    })
    .filter((video) => video.isViral)
    .sort((a, b) => b.outlierRatio - a.outlierRatio); // Сортируем от самых вирусных
}