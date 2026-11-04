import {
  PROVIDER_ORDER, PROVIDER_NAMES, PROVIDER_ICONS, WINDOW_NAMES,
  bindingWindow, level, severityFor, statusNote, pickProvider, forecastLine,
} from "./shared.js";

const body = document.getElementById("body");
const when = document.getElementById("when");

/** 설정 카드. 위젯의 설정 버튼으로 열었을 때 어디를 보라고 짚어 주려고 들고 있는다. */
let settingsEl = null;

/**
 * 지목 요청이 유효한 시각.
 *
 * 설정 버튼을 누르면 상태 갱신과 지목 요청이 거의 동시에 온다. 다시 그리면서
 * 카드를 새로 만들면 방금 붙인 표시가 지워진다. 그래서 class가 아니라 시각을
 * 들고 있다가, 그릴 때마다 아직 유효하면 다시 붙인다.
 */
let pointUntil = 0;

/** 이번에 그린 막대들. 창이 열릴 때 0에서 차오르게 하려고 목표값을 같이 들고 있는다. */
let fills = [];

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ *
 * 사용량 카드
 * ------------------------------------------------------------------ */

/**
 * 큰 숫자는 스트립과 같은 창을 쓴다. 먼저 바닥날 쪽이다.
 * 두 화면이 다른 숫자를 크게 띄우면 어느 쪽을 믿어야 할지 알 수 없다.
 */
function hero(provider) {
  const el = document.createElement("div");
  const binding = bindingWindow(provider);
  if (!binding) {
    el.className = "hero absent";
    el.innerHTML = `<span class="hnum">--</span>
      <div class="hmeta"><div class="hwin">사용량 없음</div></div>`;
    return el;
  }
  const lv = level(binding.window.leftPercent, severityFor(provider, binding.key));
  el.className = `hero lv-${lv}`;
  el.innerHTML = `
    <span class="hnum">${binding.window.leftPercent}</span><span class="hpct">%</span>
    <div class="hmeta">
      <div class="hwin">${esc(WINDOW_NAMES[binding.key])} 남음</div>
      <div class="hreset">${esc(binding.window.resetCountdown)} 뒤 리셋</div>
    </div>`;
  return el;
}

function windowRow(label, window, lv, absentNote = "데이터 없음") {
  const row = document.createElement("div");
  row.className = window ? `wrow lv-${lv}` : "wrow absent";
  row.innerHTML = `
    <span class="label">${esc(label)}</span>
    <span class="bar"><span class="fill"></span></span>
    <span class="pc">${window ? `${window.leftPercent}%` : "--"}</span>
    <span class="rs">${window ? esc(window.resetCountdown) : esc(absentNote)}</span>`;
  // 너비는 반드시 CSSOM으로 준다. CSP가 style 속성을 막으므로 마크업에 적으면
  // 조용히 버려지고 막대가 0px이 된다.
  const fill = row.querySelector(".fill");
  const target = `${window ? window.leftPercent : 0}%`;
  fill.style.width = target;
  fills.push({ fill, target });
  return row;
}

function providerCard(name, provider) {
  const card = document.createElement("section");
  card.className = "card";
  card.dataset.provider = name;
  if (!provider || provider.status === "error") card.classList.add("error");

  const head = document.createElement("div");
  head.className = "card-head";
  head.innerHTML = `
    <img class="logo" src="${esc(PROVIDER_ICONS[name] ?? "")}" alt="">
    <span class="who">${esc(PROVIDER_NAMES[name] ?? name)}</span>
    <span class="chip">${esc(provider?.plan ?? "플랜 미확인")}</span>
    <span class="spacer"></span>
    <span class="src">${esc(provider?.tokenSource ?? "")}</span>`;
  card.appendChild(head);

  const note = statusNote(provider);
  if (note) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = note;
    card.appendChild(el);
  }

  card.appendChild(hero(provider));

  // 소비 속도와 예측. "얼마 남았나"에 "언제 바닥나나"를 더한다.
  const binding = bindingWindow(provider);
  const fc = binding?.window?.forecast;
  if (fc && fc.verdict !== "unknown") {
    const row = document.createElement("div");
    row.className = `pace ${fc.verdict}`;
    const rate = fc.ratePerHour ? `시간당 ${fc.ratePerHour}%` : "거의 안 쓰는 중";
    const line = forecastLine(fc);
    row.textContent = line ? `${rate} · ${line}` : rate;
    card.appendChild(row);
  }

  const windows = [
    ["session", provider?.session],
    ["weekly", provider?.weekly],
    ["opus", provider?.models?.opus],
    ["sonnet", provider?.models?.sonnet],
  ];
  for (const [key, w] of windows) {
    // 모델별 창은 값이 있을 때만. 없는 줄을 네 개 깔면 읽을 게 없어진다.
    if (!w && (key === "opus" || key === "sonnet")) continue;
    if (!w && key === "session" && provider?.weeklyOnly) continue;
    // Ultra는 5시간 한도가 없다(2026-10 개편). 값이 안 오는 것이 정상이므로
    // "데이터 없음"이 아니라 그렇게 말한다.
    const note = (key === "session" && provider?.plan === "Ultra") ? "한도 없음" : "데이터 없음";
    card.appendChild(windowRow(WINDOW_NAMES[key], w,
      level(w?.leftPercent ?? 100, severityFor(provider, key)), note));
  }

  if (provider?.tokenExpiresAt) {
    const line = document.createElement("div");
    line.className = "meta-line";
    line.textContent = `토큰 만료 ${new Date(provider.tokenExpiresAt).toLocaleString("ko-KR")}`;
    card.appendChild(line);
  }
  return card;
}

/* ------------------------------------------------------------------ *
 * 설정
 * ------------------------------------------------------------------ */

function settingsCard(config) {
  const card = document.createElement("section");
  card.className = "card settings";
  card.innerHTML = `<div class="card-head"><span class="who">설정</span></div>`;

  card.appendChild(segRow("위젯 크기",
    [[0.7, "아주 작게"], [0.85, "작게"], [1, "보통"], [1.15, "크게"]],
    config.scale,
    (v) => window.usage.setScale(v)));

  card.appendChild(segRow("Claude 플랜",
    [["auto", "자동"], ["Pro", "Pro"], ["Max", "Max"], ["Ultra", "Ultra"]],
    config.claudePlan ?? "auto",
    (v) => window.usage.setClaudePlan(v)));

  card.appendChild(switchRow("위치 잠금", config.locked,
    (v) => window.usage.setLocked(v)));

  card.appendChild(switchRow("작업표시줄 따라 숨기기", config.followTaskbar,
    (v) => window.usage.setFollowTaskbar(v)));

  card.appendChild(switchRow("한도 임박 알림", config.notify,
    (v) => window.usage.setNotify(v)));

  card.appendChild(switchRow("윈도우 시작 시 자동 실행", config.openAtLogin,
    (v) => window.usage.setOpenAtLogin(v)));

  card.appendChild(segRow("갱신 주기",
    [[15, "15초"], [30, "30초"], [60, "1분"], [120, "2분"], [300, "5분"]],
    config.intervalSec,
    (v) => window.usage.setInterval(v)));

  return card;
}

/**
 * 분절 선택. 누른 뒤에는 메인 프로세스가 돌려준 실제 값으로 다시 맞춘다.
 * 눌렀다는 사실이 아니라 반영됐다는 사실을 보여야 한다.
 */
function segRow(label, options, current, apply) {
  const row = srow(label);
  const seg = document.createElement("div");
  seg.className = "seg";
  for (const [value, text] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.setAttribute("aria-pressed", String(current === value));
    b.addEventListener("click", async () => {
      const actual = await apply(value);
      for (const sib of seg.children) sib.setAttribute("aria-pressed", "false");
      const match = [...seg.children][options.findIndex(([v]) => v === actual)];
      (match ?? b).setAttribute("aria-pressed", "true");
    });
    seg.appendChild(b);
  }
  row.append(spacer(), seg);
  return row;
}

function switchRow(label, checked, apply) {
  const row = srow(label);
  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-label", label);
  sw.setAttribute("aria-checked", String(!!checked));
  sw.addEventListener("click", async () => {
    const next = sw.getAttribute("aria-checked") !== "true";
    const actual = await apply(next);
    // 자동 실행 같은 설정의 진실은 OS에 있다. 돌려받은 실제 값만 반영한다.
    sw.setAttribute("aria-checked", String(!!actual));
  });
  row.append(spacer(), sw);
  return row;
}

function srow(label) {
  const el = document.createElement("div");
  el.className = "srow";
  const span = document.createElement("span");
  span.textContent = label;
  el.appendChild(span);
  return el;
}

function spacer() {
  const el = document.createElement("span");
  el.className = "spacer";
  return el;
}

/* ------------------------------------------------------------------ *
 * 렌더
 * ------------------------------------------------------------------ */

function render(state) {
  body.replaceChildren();
  fills = [];
  for (const name of PROVIDER_ORDER) {
    body.appendChild(providerCard(name, pickProvider(state.report, name)));
  }
  settingsEl = settingsCard(state.config ?? {});
  body.appendChild(settingsEl);
  if (Date.now() < pointUntil) settingsEl.classList.add("pointed");
  when.textContent = state.report?.collectedAt
    ? `${new Date(state.report.collectedAt).toLocaleTimeString("ko-KR")} 기준`
    : "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const progress = document.getElementById("progress");

document.getElementById("refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "조회 중";
  progress.hidden = false;
  try {
    await window.usage.refresh();
  } finally {
    btn.disabled = false;
    btn.textContent = "새로고침";
    progress.hidden = true;
  }
});

/**
 * 창이 뜰 때: 시트가 들어오고, 막대가 0에서 제 값까지 차오른다.
 * 열 때마다 지금 상태를 처음부터 보여주는 셈이라 값이 눈에 들어온다.
 */
window.usage.onPopupShown(() => {
  if (reduceMotion) return;
  const sheet = document.querySelector(".sheet");
  sheet.classList.remove("appearing");
  void sheet.offsetWidth;          // 다시 열어도 또 보이게 되감는다
  sheet.classList.add("appearing");

  for (const { fill } of fills) fill.style.width = "0%";
  requestAnimationFrame(() => {
    for (const { fill, target } of fills) fill.style.width = target;
  });
});

document.getElementById("close").addEventListener("click", () => window.usage.closePopup());
document.getElementById("quit").addEventListener("click", () => window.usage.quit());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.usage.closePopup(); });

window.usage.onState(render);

// 위젯의 설정 버튼으로 열렸을 때. 창은 이미 떠 있으므로, 어디가 설정인지 짚어 준다.
window.usage.onFocusSettings(() => {
  pointUntil = Date.now() + 900;   // 애니메이션 길이와 같다
  if (!settingsEl) return;
  settingsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  settingsEl.classList.remove("pointed");
  void settingsEl.offsetWidth;     // 연속으로 눌러도 다시 보이게 애니메이션을 되감는다
  settingsEl.classList.add("pointed");
});

window.usage.getState().then(render);
