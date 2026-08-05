export const GENERATION_TIMEOUT_MIN_MS = 20 * 60_000;
export const GENERATION_TIMEOUT_MAX_MS = 45 * 60_000;
export const GENERATION_TIMEOUT_MULTIPLIER = 3;

export function generationTimeoutMs(durations) {
  const completedDurations = durations.filter(
    (duration) => Number.isFinite(duration) && duration > 0,
  );

  if (!completedDurations.length) return GENERATION_TIMEOUT_MIN_MS;

  const longestCompletedRender = Math.max(...completedDurations);
  const historyBasedTimeout = Math.ceil(
    (longestCompletedRender * GENERATION_TIMEOUT_MULTIPLIER) / 60_000,
  ) * 60_000;

  return Math.max(
    GENERATION_TIMEOUT_MIN_MS,
    Math.min(GENERATION_TIMEOUT_MAX_MS, historyBasedTimeout),
  );
}

export function shouldExpireGeneration({ createdAt, timeoutMs, now = Date.now() }) {
  const createdAtMs = Date.parse(createdAt);
  return Number.isFinite(createdAtMs) && now - createdAtMs > timeoutMs;
}
