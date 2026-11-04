/**
 * TTL 캐시 + 429 백오프.
 *
 * 역분석에서 확인한 사실: api.anthropic.com/api/oauth/usage 는 1분 내 두 번째 호출에
 * 바로 429를 준다. 그래서 (1) TTL 안에서는 재호출하지 않고, (2) 429를 맞으면
 * Retry-After 동안 아예 호출을 막고 마지막 성공값을 stale로 돌려준다.
 */
export class QuotaCache {
  /** @param {{ttlMs?: number, defaultBackoffMs?: number, now?: () => number}} opts */
  constructor({ ttlMs = 60_000, defaultBackoffMs = 60_000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.defaultBackoffMs = defaultBackoffMs;
    this.now = now;
    /** @type {Map<string, {value: any, at: number}>} */
    this.fresh = new Map();
    /** @type {Map<string, number>} */
    this.blockedUntil = new Map();
  }

  isBlocked(key) {
    const until = this.blockedUntil.get(key);
    return until !== undefined && this.now() < until;
  }

  /** 429를 맞았을 때 호출. Retry-After 헤더값(초 또는 HTTP-date)을 받는다. */
  block(key, retryAfterHeader) {
    this.blockedUntil.set(key, this.now() + parseRetryAfter(retryAfterHeader, this.defaultBackoffMs));
  }

  put(key, value) {
    this.fresh.set(key, { value, at: this.now() });
    this.blockedUntil.delete(key);
  }

  /** TTL 안쪽이면 값, 아니면 null. */
  getFresh(key) {
    const hit = this.fresh.get(key);
    if (!hit) return null;
    return this.now() - hit.at < this.ttlMs ? hit.value : null;
  }

  /** TTL을 넘겼어도 마지막 성공값. 없으면 null. */
  getStale(key) {
    const hit = this.fresh.get(key);
    return hit ? { value: hit.value, ageMs: this.now() - hit.at } : null;
  }

  /**
   * 디스크에 적을 수 있는 모양. 백오프 시각은 담지 않는다.
   * 다음 실행은 새 프로세스이고, 그 사이 리밋이 풀렸을 수 있다.
   */
  snapshot() {
    return {
      version: 1,
      entries: [...this.fresh].map(([key, { value, at }]) => ({ key, value, at })),
    };
  }

  /** snapshot()이 적은 것을 되살린다. 형식이 다르면 조용히 무시한다. */
  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.entries)) return false;
    for (const e of snapshot.entries) {
      if (typeof e?.key === "string" && typeof e?.at === "number" && e.value) {
        this.fresh.set(e.key, { value: e.value, at: e.at });
      }
    }
    return true;
  }
}

/** Retry-After: 초 단위 숫자 또는 HTTP-date. 둘 다 받아 ms로 바꾼다. */
export function parseRetryAfter(header, fallbackMs = 60_000) {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3_600_000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.min(at - Date.now(), 3_600_000));
  return fallbackMs;
}
