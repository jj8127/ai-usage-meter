/**
 * 소비 속도와 소진 예측.
 *
 * 위젯이 "81% 남음, 리셋까지 4d 20h"만 보여주면, 끊길지 아닐지는 사용자가
 * 머릿속으로 계산해야 한다. 그 계산을 여기서 한다.
 *
 * 입력은 수집기가 주기적으로 받는 잔여 %뿐이다. 새 API도 새 권한도 필요 없다.
 */

/** 창 길이(시간). 남길 것 같은지 판단할 때 "창의 끝자락"을 가늠하는 데 쓴다. */
export const WINDOW_HOURS = { session: 5, weekly: 168, opus: 168, sonnet: 168 };

/** 기울기를 믿으려면 이만큼은 모여야 한다. 1~2개로 외삽하면 숫자가 춤춘다. */
const MIN_SAMPLES = 3;
const MIN_SPAN_MIN = 5;
/** 이보다 느리면 "거의 안 쓰는 중"으로 본다. 측정 잡음과 구분하기 위한 바닥값. */
const IDLE_RATE = 0.05;        // %/시간
/** 창이 이만큼 남았을 때부터 "남길 것 같다"를 따진다. */
const ENDGAME_FRACTION = 0.25;
/** 리셋 때 이만큼 넘게 남을 것 같으면 낭비로 본다. */
const SURPLUS_LEFT = 30;       // %

/**
 * 표본을 창 단위로 모은다.
 *
 * 창이 리셋되면 잔여 %가 위로 튄다. 그 표본들을 같이 두면 기울기가 거꾸로 나와
 * "무한히 버틴다"는 엉뚱한 예측이 된다. 리셋 시각이 바뀌면 통째로 버린다.
 *
 * @param {{resetsAt: string|null, samples: {t: number, left: number}[]}|null} series
 * @param {{resetsAt: string|null, leftPercent: number}} window
 * @param {number} now
 * @param {number} cap 보관할 표본 수 상한
 */
/**
 * 리셋 시각을 분 단위로 자른다.
 *
 * Anthropic은 같은 창인데도 응답마다 마이크로초가 다른 값을 준다
 * (`...00.807782`, `...00.483204`). 문자열로 비교하면 매번 새 창으로 보고
 * 표본을 버려서 예측이 영영 나오지 않는다. 실제로 Claude만 표본이 1개에서
 * 늘지 않았다.
 */
export function windowKeyOf(resetsAt) {
  if (!resetsAt) return "none";
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return String(resetsAt);
  return String(Math.round(t / 60_000));
}

export function trackWindow(series, window, now = Date.now(), cap = 240) {
  if (!window || !Number.isFinite(window.leftPercent)) return series ?? null;

  const resetsAt = window.resetsAt ?? null;
  const fresh = !series || windowKeyOf(series.resetsAt) !== windowKeyOf(resetsAt);
  const samples = fresh ? [] : series.samples.slice();

  // 잔여가 뚜렷하게 올라갔으면 리셋 시각이 그대로여도 새 창으로 본다.
  const last = samples[samples.length - 1];
  if (last && window.leftPercent > last.left + 5) samples.length = 0;

  samples.push({ t: now, left: window.leftPercent });
  if (samples.length > cap) samples.splice(0, samples.length - cap);
  return { resetsAt, samples };
}

/** 최소제곱으로 기울기를 구한다. 점 몇 개의 차이보다 흔들림이 적다. */
function slopePerHour(samples) {
  const n = samples.length;
  const t0 = samples[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const s of samples) {
    const x = (s.t - t0) / 3_600_000;   // 시간 단위
    sx += x; sy += s.left; sxx += x * x; sxy += x * s.left;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;   // 잔여 %의 시간당 변화량 (보통 음수)
}

/**
 * 예측을 낸다.
 *
 * @returns {{
 *   ratePerHour: number|null,      시간당 소비 %. 양수면 쓰는 중
 *   hoursToEmpty: number|null,     이 속도면 바닥까지 남은 시간
 *   emptyAt: string|null,
 *   projectedLeft: number|null,    리셋 시점에 남아 있을 것 같은 %
 *   verdict: "unknown"|"ok"|"runout"|"surplus",
 *   samples: number,
 *   spanMinutes: number
 * }}
 */
export function forecast(series, window, windowKey = "weekly", now = Date.now()) {
  const empty = {
    ratePerHour: null, hoursToEmpty: null, emptyAt: null,
    projectedLeft: null, verdict: "unknown", samples: 0, spanMinutes: 0,
  };
  if (!series?.samples?.length || !window || !Number.isFinite(window.leftPercent)) return empty;

  const samples = series.samples;
  const spanMinutes = (samples[samples.length - 1].t - samples[0].t) / 60_000;
  const base = { ...empty, samples: samples.length, spanMinutes: Math.round(spanMinutes) };
  if (samples.length < MIN_SAMPLES || spanMinutes < MIN_SPAN_MIN) return base;

  const rate = -slopePerHour(samples);              // 소비 속도(양수 = 줄어드는 중)
  const left = window.leftPercent;
  const hoursToReset = Number.isFinite(window.resetInMs) ? window.resetInMs / 3_600_000 : null;

  if (rate <= IDLE_RATE) {
    // 거의 안 쓰는 중. 바닥날 일은 없고, 창 끝자락이면 남길 것 같다고 본다.
    const verdict = isEndgame(hoursToReset, windowKey) && left > SURPLUS_LEFT ? "surplus" : "ok";
    // 반올림을 빼먹으면 3.9e-13 같은 부동소수점 찌꺼기가 그대로 화면에 나온다.
    return { ...base, ratePerHour: round1(Math.max(0, rate)), projectedLeft: left, verdict };
  }

  const hoursToEmpty = left / rate;
  const projectedLeft = hoursToReset === null
    ? null
    : Math.max(0, left - rate * hoursToReset);

  let verdict = "ok";
  if (hoursToReset !== null && hoursToEmpty < hoursToReset) verdict = "runout";
  else if (isEndgame(hoursToReset, windowKey) && (projectedLeft ?? 0) > SURPLUS_LEFT) verdict = "surplus";

  return {
    ...base,
    ratePerHour: round1(rate),
    hoursToEmpty: round1(hoursToEmpty),
    emptyAt: new Date(now + hoursToEmpty * 3_600_000).toISOString(),
    projectedLeft: projectedLeft === null ? null : Math.round(projectedLeft),
    verdict,
  };
}

/** 창이 끝자락인가. 주간 창 첫날에 "남길 것 같다"고 말해 봐야 쓸모가 없다. */
function isEndgame(hoursToReset, windowKey) {
  if (hoursToReset === null) return false;
  const total = WINDOW_HOURS[windowKey] ?? 168;
  return hoursToReset <= total * ENDGAME_FRACTION;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 팝업용 한 문장. 자리가 넉넉하므로 온전히 적는다. */
export function forecastLine(f) {
  if (!f || f.verdict === "unknown") return null;
  if (f.verdict === "runout") return `${formatHours(f.hoursToEmpty)} 뒤 한도 소진`;
  if (f.verdict === "surplus") return `리셋 때 ${f.projectedLeft}% 남길 듯`;
  return null;   // 평상시에는 아무 말도 하지 않는다
}

export function formatHours(hours) {
  if (!Number.isFinite(hours)) return "--";
  const mins = Math.round(hours * 60);
  if (mins < 60) return `${Math.max(1, mins)}min`;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}
