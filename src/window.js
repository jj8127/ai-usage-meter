/**
 * 사용량 창(5시간 / 7일 등)을 하나의 모양으로 정규화한다.
 *
 * 분석 대상 위젯의 버그를 여기서 피한다: 위젯은 `five_hour`가 null이면
 * `seven_day`가 멀쩡해도 응답 전체를 에러로 버렸다(main.js:400). 창은 서로
 * 독립이므로 각각 null을 허용하고, 하나라도 살아 있으면 ready로 본다.
 */

/**
 * @param {any} raw usage 응답의 한 창 객체. null/undefined 허용.
 * @returns {null | {usedPercent: number, leftPercent: number, resetsAt: string|null,
 *                  resetInMs: number|null, resetCountdown: string, exhausted: boolean}}
 */
export function normalizeWindow(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.utilization);
  if (!Number.isFinite(used)) return null;

  const usedPercent = clampPercent(used);
  const resetsAt = typeof raw.resets_at === "string" ? raw.resets_at : null;
  const resetAtMs = resetsAt ? Date.parse(resetsAt) : NaN;
  const resetInMs = Number.isNaN(resetAtMs) ? null : Math.max(0, resetAtMs - now);

  return {
    usedPercent,
    leftPercent: Math.max(0, 100 - usedPercent),
    resetsAt,
    resetInMs,
    resetCountdown: formatCountdown(resetInMs),
    exhausted: usedPercent >= 100,
  };
}

export function clampPercent(n) {
  return Math.min(100, Math.max(0, Math.round(Number(n) * 10) / 10));
}

/** 남은 시간을 "3시간 12분" / "12분" 꼴로. 값이 없으면 "--". */
export function formatCountdown(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "--";
  if (ms <= 0) return "곧 리셋";
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
  if (hours > 0) return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  return `${mins}분`;
}
