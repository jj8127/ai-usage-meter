import { QuotaCache } from "./cache.js";
import { collectClaude } from "./claude.js";
import { collectCodex } from "./codex.js";

export { QuotaCache, parseRetryAfter } from "./cache.js";
export { loadCache, saveCache, defaultCachePath } from "./store.js";
export { loadForecastState, saveForecastState } from "./store.js";
export { trackWindow, forecast, forecastLine, formatHours, WINDOW_HOURS } from "./forecast.js";
export { collectAlerts, alertText, DEFAULT_THRESHOLDS } from "./alerts.js";
export { collectClaude, resolveToken, formatPlan, normalizeUsage } from "./claude.js";
export { collectCodex, findCodexExecutable, formatCodexPlan } from "./codex.js";
export { normalizeWindow, formatCountdown } from "./window.js";

/**
 * 한 번의 수집으로 두 제공자를 모두 조회한다.
 * 한쪽이 실패해도 다른 쪽은 그대로 돌려준다 (Promise.all이 아니라 allSettled).
 *
 * @param {QuotaCache} cache 호출자가 들고 있어야 한다. 매번 새로 만들면 캐시 의미가 없다.
 * @returns {Promise<{collectedAt: string, providers: object[]}>}
 */
export async function collectAll(cache, opts = {}) {
  const tasks = [
    ["claude", () => collectClaude(cache, opts)],
    ["codex", () => collectCodex(cache, opts)],
  ];
  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));

  const providers = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      provider: tasks[i][0],
      status: "error",
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      plan: null,
      session: null,
      weekly: null,
      models: {},
      pace: null,
      updatedAt: new Date().toISOString(),
      cache: "miss",
    };
  });

  return { collectedAt: new Date().toISOString(), providers };
}

/** 위젯 하나가 쓸 기본 캐시. TTL 60초는 역분석에서 확인한 429 간격을 고려한 값이다. */
export function createCache(opts = {}) {
  return new QuotaCache({ ttlMs: 60_000, defaultBackoffMs: 60_000, ...opts });
}
