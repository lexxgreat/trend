// metrics.mjs — единый модуль честных метрик просмотров.
// Используется scanChannelsRss.mjs, findViralVideos.mjs, server.mjs и migrate.mjs.

export const HOUR_MS = 60 * 60 * 1000;
// Сколько срезов истории храним (1 в час ~ 2 суток)
export const METRICS_HISTORY_LIMIT = 48;

/**
 * Добавляет срез {t, views} в историю метрик видео.
 * Срезы ближе 1 часа друг к другу схлопываются (не чаще раза в час).
 */
export function appendMetricsHistory(existingVideo, now, views) {
  const history = Array.isArray(existingVideo.metricsHistory)
    ? existingVideo.metricsHistory.filter(h => h && Number.isFinite(h.t) && h.t > 0)
    : [];
  const last = history[history.length - 1];
  if (last && (now - last.t) < HOUR_MS) {
    // Обновляем срез в пределах текущего часа — сохраняем свежие просмотры
    last.views = views;
  } else {
    history.push({ t: now, views });
  }
  // Храним не больше лимита (сдвигаем с начала)
  while (history.length > METRICS_HISTORY_LIMIT) history.shift();
  return history;
}

/**
 * Есть ли в истории точка, достаточно старая для окна (winMs).
 */
export function hasPointOlderThan(history, now, winMs) {
  if (!Array.isArray(history)) return false;
  for (const p of history) {
    if (p && Number.isFinite(p.t) && p.t > 0 && p.t <= now - winMs) return true;
  }
  return false;
}

/**
 * Прирост просмотров за окно (по умолчанию 24 часа) с линейной интерполяцией.
 * Берёт последнюю точку истории, которая НЕ моложе (now - winMs), и масштабирует
 * прирост пропорционально времени. Если такой точки нет — возвращает 0 (данных мало,
 * честный ответ — "неизвестно"). Проверку "достаточно ли данных" делайте через
 * hasPointOlderThan(history, now, winMs).
 */
export function gainOverWindow(history, now, winMs = 24 * HOUR_MS) {
  if (!Array.isArray(history) || history.length < 2) return 0;

  const sorted = history.slice().sort((a, b) => a.t - b.t);
  const latest = sorted[sorted.length - 1];
  if (!latest || !Number.isFinite(latest.views)) return 0;

  // Ищем последнюю (самую позднюю) точку старше окна
  let base = null;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const p = sorted[i];
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.views)) continue;
    if (p.t <= now - winMs) { base = p; break; }
  }
  if (!base) return 0;

  const dt = Math.max(HOUR_MS / 60, latest.t - base.t); // минимум 1 минута
  const gain = (latest.views - base.views) * (winMs / dt);
  return Math.max(0, Math.round(gain));
}

/**
 * Темп прироста за последний час (views/час по последним двум срезам).
 */
export function computeHourlyRate(history, now) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  const sorted = history.slice().sort((a, b) => a.t - b.t);
  const latest = sorted[sorted.length - 1];
  let prev = null;
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (Number.isFinite(sorted[i].t) && Number.isFinite(sorted[i].views)) { prev = sorted[i]; break; }
  }
  if (!prev) return 0;
  const dtHours = Math.max(0.5, (latest.t - prev.t) / HOUR_MS);
  if (dtHours <= 0) return 0;
  return Math.max(0, Math.round((latest.views - prev.views) / dtHours));
}

/**
 * BOOM-детектор: прирост за 24ч ≥50% просмотров ИЛИ темп ≥20%/час.
 */
export function isBoom(history, now, currentViews, gain24h = null, hourlyRate = null) {
  const g24 = gain24h !== null ? gain24h : gainOverWindow(history, now, 24 * HOUR_MS);
  const hr = hourlyRate !== null ? hourlyRate : computeHourlyRate(history, now);
  return g24 >= 0.5 * (currentViews || 1) || hr >= 0.2 * (currentViews || 1);
}

/**
 * Объединение историй двух дублей (для дедупликации) — сортировка + схлопывание часа.
 * Возвращает новый массив (не более METRICS_HISTORY_LIMIT точек).
 */
export function mergeHistories(aHistory, bHistory) {
  const merged = []
    .concat(aHistory || [], bHistory || [])
    .filter(h => h && Number.isFinite(h.t) && Number.isFinite(h.views))
    .sort((a, b) => a.t - b.t);
  const collapsed = [];
  for (const h of merged) {
    if (collapsed.length && (h.t - collapsed[collapsed.length - 1].t) < HOUR_MS) {
      collapsed[collapsed.length - 1] = h; // берём последнюю точку часа
    } else {
      collapsed.push(h);
    }
  }
  return collapsed.slice(-METRICS_HISTORY_LIMIT);
}