import { test } from "node:test";
import assert from "node:assert/strict";

import { trackWindow, forecast, forecastLine, formatHours } from "../src/forecast.js";
import { collectAlerts, alertText } from "../src/alerts.js";

const H = 3_600_000;
const T0 = Date.parse("2026-11-04T00:00:00Z");

/** 일정한 속도로 줄어드는 표본을 만든다. */
function series(resetsAt, from, ratePerHour, hours, stepMin = 10) {
  let s = null;
  for (let m = 0; m <= hours * 60; m += stepMin) {
    const left = Math.max(0, from - ratePerHour * (m / 60));
    s = trackWindow(s, { resetsAt, leftPercent: Math.round(left * 10) / 10 }, T0 + m * 60_000);
  }
  return s;
}

/* ---------- 표본 모으기 ---------- */

test("리셋 시각이 바뀌면 표본을 버린다", () => {
  let s = series("A", 50, 5, 2);
  assert.ok(s.samples.length > 3);
  s = trackWindow(s, { resetsAt: "B", leftPercent: 100 }, T0 + 3 * H);
  assert.equal(s.samples.length, 1);
  assert.equal(s.resetsAt, "B");
});

test("리셋 시각이 그대로여도 잔여가 뛰어오르면 새 창으로 본다", () => {
  let s = series("A", 20, 5, 2);
  s = trackWindow(s, { resetsAt: "A", leftPercent: 100 }, T0 + 3 * H);
  assert.equal(s.samples.length, 1, "옛 표본이 남으면 기울기가 거꾸로 나온다");
});

test("표본 수에 상한이 있다", () => {
  let s = null;
  for (let i = 0; i < 50; i++) s = trackWindow(s, { resetsAt: "A", leftPercent: 100 - i }, T0 + i * 60_000, 10);
  assert.equal(s.samples.length, 10);
  assert.equal(s.samples[s.samples.length - 1].left, 51);
});

/* ---------- 예측 ---------- */

test("표본이 적으면 판단하지 않는다", () => {
  const s = trackWindow(null, { resetsAt: "A", leftPercent: 80 }, T0);
  const f = forecast(s, { leftPercent: 80, resetInMs: 10 * H }, "weekly", T0);
  assert.equal(f.verdict, "unknown");
  assert.equal(f.ratePerHour, null);
});

test("짧은 구간만으로는 판단하지 않는다", () => {
  let s = null;
  for (let i = 0; i < 4; i++) s = trackWindow(s, { resetsAt: "A", leftPercent: 80 - i }, T0 + i * 60_000);
  const f = forecast(s, { leftPercent: 77, resetInMs: 10 * H }, "weekly", T0 + 3 * 60_000);
  assert.equal(f.verdict, "unknown", "3분짜리 기울기로 외삽하면 숫자가 춤춘다");
});

test("소비 속도를 시간당 %로 낸다", () => {
  const s = series("A", 100, 4, 3);              // 시간당 4%씩
  const f = forecast(s, { leftPercent: 88, resetInMs: 100 * H }, "weekly", T0 + 3 * H);
  assert.ok(Math.abs(f.ratePerHour - 4) < 0.3, `rate=${f.ratePerHour}`);
  assert.ok(Math.abs(f.hoursToEmpty - 22) < 2, `hours=${f.hoursToEmpty}`);
});

test("리셋 전에 바닥나면 runout", () => {
  const s = series("A", 100, 10, 3);             // 시간당 10% -> 7시간이면 바닥
  const f = forecast(s, { leftPercent: 70, resetInMs: 20 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.verdict, "runout");
  assert.ok(f.hoursToEmpty < 20);
});

test("리셋까지 버티고 창 초반이면 ok", () => {
  const s = series("A", 100, 1, 3);
  // 시간당 1%면 97시간 뒤 바닥. 리셋이 50시간 뒤라 버티고, 주간 끝자락(42시간)도 아니다.
  const f = forecast(s, { leftPercent: 97, resetInMs: 50 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.verdict, "ok");
  assert.equal(forecastLine(f), null, "평상시에는 아무 말도 하지 않는다");
});

test("버티긴 하지만 끝자락에 많이 남으면 surplus", () => {
  // 주간 창이 20시간 남았는데 97%가 남아 있으면 바닥날 일은 없지만 낭비다.
  const s = series("A", 100, 1, 3);
  const f = forecast(s, { leftPercent: 97, resetInMs: 20 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.verdict, "surplus");
  assert.equal(f.projectedLeft, 77);
});

test("창 끝자락에 많이 남을 것 같으면 surplus", () => {
  const s = series("A", 90, 0.5, 3);             // 거의 안 씀
  const f = forecast(s, { leftPercent: 88, resetInMs: 10 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.verdict, "surplus");
  assert.match(forecastLine(f), /남길 듯/);
});

test("창 초반에는 많이 남아도 surplus라 하지 않는다", () => {
  const s = series("A", 95, 0.2, 3);
  const f = forecast(s, { leftPercent: 94, resetInMs: 160 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.verdict, "ok", "주간 첫날에 '남길 듯'은 쓸모가 없다");
});

test("5시간 창은 끝자락 기준이 더 짧다", () => {
  const s = series("A", 80, 0.3, 1);
  // 5시간 창의 25% = 1.25시간
  const near = forecast(s, { leftPercent: 79, resetInMs: 1 * H }, "session", T0 + 1 * H);
  const far = forecast(s, { leftPercent: 79, resetInMs: 4 * H }, "session", T0 + 1 * H);
  assert.equal(near.verdict, "surplus");
  assert.equal(far.verdict, "ok");
});

test("안 쓰는 중이면 바닥 예측을 내지 않는다", () => {
  const s = series("A", 60, 0, 3);
  const f = forecast(s, { leftPercent: 60, resetInMs: 100 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.hoursToEmpty, null);
  assert.equal(f.verdict, "ok");
});

test("시간 표기", () => {
  assert.equal(formatHours(0.5), "30min");
  assert.equal(formatHours(2.5), "2h 30min");
  assert.equal(formatHours(30), "1d 6h");
  assert.equal(formatHours(NaN), "--");
});

/* ---------- 알림 ---------- */

const W = (left, resetsAt = "A") => ({ leftPercent: left, resetsAt });

test("임계값을 넘어가면 한 번 울린다", () => {
  const r1 = collectAlerts({}, { provider: "claude", windows: [{ key: "weekly", window: W(24) }] });
  assert.equal(r1.alerts.length, 1);
  assert.equal(r1.alerts[0].threshold, 25);

  // 같은 창에서는 다시 울리지 않는다
  const r2 = collectAlerts(r1.fired, { provider: "claude", windows: [{ key: "weekly", window: W(23) }] });
  assert.equal(r2.alerts.length, 0);
});

test("더 급한 임계값은 따로 울린다", () => {
  let fired = collectAlerts({}, { provider: "claude", windows: [{ key: "weekly", window: W(24) }] }).fired;
  const r = collectAlerts(fired, { provider: "claude", windows: [{ key: "weekly", window: W(9) }] });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].threshold, 10);
});

test("한 번에 두 임계값을 지나쳐도 급한 쪽 하나만 울린다", () => {
  const r = collectAlerts({}, { provider: "claude", windows: [{ key: "weekly", window: W(5) }] });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].threshold, 10);
});

test("창이 리셋되면 다시 울린다", () => {
  const fired = collectAlerts({}, { provider: "claude", windows: [{ key: "weekly", window: W(20, "A") }] }).fired;
  const r = collectAlerts(fired, { provider: "claude", windows: [{ key: "weekly", window: W(20, "B") }] });
  assert.equal(r.alerts.length, 1, "새 창에서는 다시 알려야 한다");
});

test("여유 있어 보여도 이 속도면 바닥나면 미리 알린다", () => {
  const r = collectAlerts({}, {
    provider: "codex",
    windows: [{ key: "session", window: W(70), forecast: { verdict: "runout", hoursToEmpty: 1.5 } }],
  });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].kind, "runout");
});

test("바닥 예측도 창당 한 번만 울린다", () => {
  const w = [{ key: "session", window: W(70), forecast: { verdict: "runout", hoursToEmpty: 1.5 } }];
  const fired = collectAlerts({}, { provider: "codex", windows: w }).fired;
  assert.equal(collectAlerts(fired, { provider: "codex", windows: w }).alerts.length, 0);
});

test("사라진 창의 기록은 정리된다", () => {
  const fired = collectAlerts({}, { provider: "claude", windows: [{ key: "opus", window: W(5) }] }).fired;
  assert.ok(Object.keys(fired).some((k) => k.includes("opus")));
  const r = collectAlerts(fired, { provider: "claude", windows: [{ key: "weekly", window: W(90) }] });
  assert.ok(!Object.keys(r.fired).some((k) => k.includes("opus")), "기록이 끝없이 자라면 안 된다");
});

test("알림 문구", () => {
  const t = alertText({ kind: "threshold", leftPercent: 9 },
    { providerName: "Claude", windowName: "주간", resetCountdown: "2d 3h", formatHours });
  assert.match(t.title, /Claude 주간 9% 남음/);
  assert.match(t.body, /2d 3h/);

  const r = alertText({ kind: "runout", leftPercent: 70, hoursToEmpty: 1.5 },
    { providerName: "Codex", windowName: "5시간", resetCountdown: "4h", formatHours });
  assert.match(r.title, /한도 곧 소진/);
  assert.match(r.body, /1h 30min 뒤 0%/);
});

/* ---------- 리셋 시각의 마이크로초 흔들림 ---------- */

test("같은 창인데 마이크로초만 다르면 표본을 버리지 않는다", () => {
  // Anthropic은 같은 창에도 응답마다 다른 마이크로초를 준다.
  let s = trackWindow(null, { resetsAt: "2026-11-08T11:00:00.807782+00:00", leftPercent: 80 }, T0);
  s = trackWindow(s, { resetsAt: "2026-11-08T11:00:00.483204+00:00", leftPercent: 79 }, T0 + 10 * 60_000);
  s = trackWindow(s, { resetsAt: "2026-11-08T11:00:00.991000+00:00", leftPercent: 78 }, T0 + 20 * 60_000);
  assert.equal(s.samples.length, 3, "문자열로 비교하면 매번 1개로 돌아간다");
});

test("분이 다르면 다른 창으로 본다", () => {
  let s = trackWindow(null, { resetsAt: "2026-11-08T11:00:00Z", leftPercent: 80 }, T0);
  s = trackWindow(s, { resetsAt: "2026-11-08T11:05:00Z", leftPercent: 80 }, T0 + 60_000);
  assert.equal(s.samples.length, 1);
});

test("마이크로초만 달라도 같은 알림을 반복하지 않는다", () => {
  const a = { key: "weekly", window: { leftPercent: 20, resetsAt: "2026-11-08T11:00:00.807782+00:00" } };
  const b = { key: "weekly", window: { leftPercent: 19, resetsAt: "2026-11-08T11:00:00.483204+00:00" } };
  const r1 = collectAlerts({}, { provider: "claude", windows: [a] });
  assert.equal(r1.alerts.length, 1);
  const r2 = collectAlerts(r1.fired, { provider: "claude", windows: [b] });
  assert.equal(r2.alerts.length, 0, "갱신 주기마다 같은 알림이 반복되면 안 된다");
});


test("거의 안 쓸 때 속도에 부동소수점 찌꺼기가 남지 않는다", () => {
  const s = series("A", 60, 0, 3);
  const f = forecast(s, { leftPercent: 60, resetInMs: 100 * H }, "weekly", T0 + 3 * H);
  assert.equal(f.ratePerHour, 0, `3.9e-13 같은 값이 화면에 나오면 안 된다: ${f.ratePerHour}`);
});
