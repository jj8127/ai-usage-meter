/** 위젯과 팝업이 같이 쓰는 표시 규칙. 두 화면의 숫자와 색이 어긋나지 않게 한 곳에 둔다. */

export { forecastLine, formatHours } from "../src/forecast.js";

export const PROVIDER_ORDER = ["claude", "codex"];
export const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" };

/**
 * 제공자 로고. 스트립에서는 이름 글자 대신 이것만 쓴다. 모양과 색으로 바로 알아보므로
 * "Claude"라고 적을 자리를 숫자와 카운트다운에 넘길 수 있다.
 * 각 마크는 Anthropic과 OpenAI의 상표이고, 어느 서비스의 사용량인지 가리키는 데만 쓴다.
 */
export const PROVIDER_ICONS = { claude: "icons/claude.png", codex: "icons/codex.png" };
export const WINDOW_NAMES = { session: "5시간", weekly: "주간", opus: "Opus 주간", sonnet: "Sonnet 주간" };

/**
 * 스트립에 붙이는 짧은 창 이름.
 * 큰 숫자만 있으면 그것이 5시간 한도인지 주간 한도인지 알 수 없다.
 * 두 글자면 카운트다운 앞에 붙여도 자리를 거의 먹지 않는다.
 */
export const WINDOW_TAGS = { session: "5H", weekly: "WK", opus: "OPUS", sonnet: "SONNET" };

/**
 * 먼저 바닥날 창을 고른다.
 *
 * 스트립에는 큰 숫자를 하나만 놓을 수 있다. 그렇다면 판단에 쓰이는 숫자여야 한다.
 * 5시간 50% + 주간 90%라면 작업이 끊기는 것은 5시간 쪽이다.
 */
export function bindingWindow(provider) {
  const windows = [
    ["session", provider?.session],
    ["weekly", provider?.weekly],
  ].filter(([, w]) => w);
  if (!windows.length) return null;
  windows.sort((a, b) => a[1].leftPercent - b[1].leftPercent);
  return { key: windows[0][0], window: windows[0][1] };
}

/**
 * 색 단계.
 *
 * 기본은 남은 비율 임계값이다. 다만 Anthropic이 `limits[].severity`로 직접 판정해 주면
 * 그쪽을 따른다. 우리가 정한 임계값보다 발급자의 판정이 정확하다.
 */
export function level(leftPercent, apiSeverity) {
  const bySeverity = { normal: null, warning: "warn", warn: "warn", critical: "crit", exceeded: "crit" };
  const fromApi = bySeverity[String(apiSeverity ?? "").toLowerCase()];
  if (fromApi) return fromApi;
  if (leftPercent <= 8) return "crit";
  if (leftPercent <= 25) return "warn";
  return "ok";
}

/** limits 배열에서 이 창에 해당하는 활성 항목의 severity를 찾는다. 없으면 undefined. */
export function severityFor(provider, windowKey) {
  const group = windowKey === "session" ? "session" : "weekly";
  const hit = (provider?.limits ?? []).find((l) => l?.is_active && l?.group === group);
  return hit?.severity;
}

/**
 * 스트립에 쓸 짧은 플랜 이름.
 *
 * "ChatGPT Plus"는 320px 스트립에서 카운트다운을 밀어낸다. 셀 머리에 이미
 * "Codex"가 있으므로 제공자 이름을 두 번 적을 이유가 없다. 팝업에서는 전체 이름을 쓴다.
 */
export function shortPlan(plan) {
  if (!plan) return null;
  return plan.replace(/^ChatGPT\s+/i, "");
}

/** 수집 상태를 사람이 읽는 한 줄로. 숫자를 꾸며내지 않으므로 상태를 분명히 적는다. */
export function statusNote(provider) {
  if (!provider) return "데이터 없음";
  if (provider.status === "ready") return null;
  if (provider.status === "stale") {
    const min = Math.round((provider.staleAgeMs ?? 0) / 60000);
    return `${min}분 전 실측 · ${provider.error ?? "갱신 실패"}`;
  }
  return provider.error ?? "조회 실패";
}

export function pickProvider(report, name) {
  return report?.providers?.find((p) => p.provider === name) ?? null;
}
