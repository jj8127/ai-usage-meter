/**
 * 알림 판단.
 *
 * 왜 필요한가: 위젯이 작업표시줄을 따라 숨으므로, 사용자는 마우스를 아래로 내릴 때만
 * 화면을 본다. 25%·8%에서 색이 바뀌어도 볼 기회가 거의 없다. 색은 보고 있을 때만
 * 쓸모가 있고, 끊김을 막으려면 보고 있지 않을 때 알려야 한다.
 *
 * 순수 함수로 둔다. 같은 입력이면 같은 알림이 나오고, 테스트로 울림·안 울림을
 * 그대로 확인할 수 있다.
 */

import { windowKeyOf } from "./forecast.js";

export const DEFAULT_THRESHOLDS = [25, 10];

/**
 * 울릴 알림을 고른다.
 *
 * 한 번 울린 것은 그 창이 리셋될 때까지 다시 울리지 않는다. 창이 바뀌면
 * (resetsAt이 달라지면) 기록을 버려서 새 창에서는 다시 울린다.
 *
 * @param {object} fired 이미 울린 기록. { "claude:weekly:25": "<resetsAt>" }
 * @param {object} input
 *   provider  제공자 이름
 *   windows   [{ key, window, forecast }]
 *   thresholds 잔여 % 임계값
 * @returns {{alerts: {id, provider, windowKey, kind, leftPercent, title, body}[], fired: object}}
 */
export function collectAlerts(fired, { provider, windows, thresholds = DEFAULT_THRESHOLDS }) {
  const next = { ...fired };
  const alerts = [];

  for (const { key, window, forecast } of windows ?? []) {
    if (!window || !Number.isFinite(window.leftPercent)) continue;
    // 리셋 시각을 그대로 쓰면 안 된다. 응답마다 마이크로초가 달라서 스탬프가
    // 매번 바뀌고, 그러면 같은 임계값 알림이 갱신 주기마다 반복된다.
    const stamp = windowKeyOf(window.resetsAt);

    // 잔여 임계값. 낮은 쪽(더 급한 쪽)부터 봐서 한 번에 하나만 울린다.
    for (const t of [...thresholds].sort((a, b) => a - b)) {
      if (window.leftPercent > t) continue;
      const id = `${provider}:${key}:${t}`;
      if (next[id] === stamp) continue;          // 이 창에서는 이미 울렸다
      next[id] = stamp;
      alerts.push({
        id, provider, windowKey: key, kind: "threshold",
        leftPercent: window.leftPercent, threshold: t,
      });
      break;
    }

    // 아직 여유가 있어 보여도, 이 속도면 리셋 전에 바닥난다면 미리 알린다.
    if (forecast?.verdict === "runout") {
      const id = `${provider}:${key}:runout`;
      if (next[id] !== stamp) {
        next[id] = stamp;
        alerts.push({
          id, provider, windowKey: key, kind: "runout",
          leftPercent: window.leftPercent, hoursToEmpty: forecast.hoursToEmpty,
        });
      }
    }
  }

  // 지난 창의 기록은 지운다. 그대로 두면 설정 파일이 끝없이 자란다.
  const live = new Set((windows ?? []).map(({ key }) => `${provider}:${key}:`));
  for (const id of Object.keys(next)) {
    if (!id.startsWith(`${provider}:`)) continue;
    const prefix = id.slice(0, id.lastIndexOf(":") + 1);
    if (!live.has(prefix)) delete next[id];
  }

  return { alerts, fired: next };
}

/** 알림 문구. 무엇이 얼마 남았고 언제까지인지만 적는다. */
export function alertText(alert, { providerName, windowName, resetCountdown, formatHours }) {
  if (alert.kind === "runout") {
    return {
      title: `${providerName} ${windowName} 한도 곧 소진`,
      body: `${alert.leftPercent}% 남음 · 이 속도면 ${formatHours(alert.hoursToEmpty)} 뒤 0%`
        + (resetCountdown ? ` · 리셋 ${resetCountdown}` : ""),
    };
  }
  return {
    title: `${providerName} ${windowName} ${alert.leftPercent}% 남음`,
    body: resetCountdown ? `리셋까지 ${resetCountdown}` : "",
  };
}
