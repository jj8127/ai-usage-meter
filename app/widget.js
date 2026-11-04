import {
  PROVIDER_ORDER, PROVIDER_NAMES, PROVIDER_ICONS, WINDOW_NAMES, WINDOW_TAGS,
  level, severityFor, pickProvider, shortPlan,
} from "./shared.js";

const plate = document.getElementById("plate");

/**
 * 셀 DOM을 들고 있다가 값만 갈아 끼운다.
 *
 * 상태가 올 때마다 통째로 다시 만들면 매번 새 엘리먼트라서 CSS 전환이 실행되지
 * 않는다. 막대가 스르르 줄지 않고 그냥 튄다. 구조는 한 번만 만들고 값만 쓴다.
 */
const cells = new Map();
let built = false;

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 한 셀에 두 창을 모두 보여준다. 그래야 "어느 창의 값이냐"를 물을 일이 없다. */
const ROW_KEYS = ["session", "weekly"];

/* ------------------------------------------------------------------ *
 * 구조 만들기
 * ------------------------------------------------------------------ */

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function buildCell(name) {
  const cell = el("div", "cell");
  cell.dataset.provider = name;

  const dot = el("div", "dot");

  const id = el("div", "id");
  const logo = el("img", "logo");
  logo.src = PROVIDER_ICONS[name] ?? "";
  logo.alt = PROVIDER_NAMES[name] ?? name;
  const plan = el("div", "plan");
  id.append(logo, plan);

  const rows = el("div", "rows");
  const refs = {};
  for (const key of ROW_KEYS) {
    const row = el("div", "row");
    const tag = el("span", "tag");
    tag.textContent = WINDOW_TAGS[key];
    const bar = el("span", "bar");
    const fill = el("span", "fill");
    bar.appendChild(fill);
    const pc = el("span", "pc");
    const rs = el("span", "rs");
    row.append(tag, bar, pc, rs);
    rows.appendChild(row);
    refs[key] = { row, bar, fill, pc, rs };
  }

  cell.append(dot, id, rows);
  cells.set(name, { cell, logo, plan, dot, refs });
  return cell;
}

/**
 * 설정 톱니.
 *
 * 오른쪽 위 모서리에 둔다. 플레이트 오른쪽 여백에 앉아 글자와 겹치지 않는다.
 */
function gearButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "gear";
  btn.title = "설정";
  btn.setAttribute("aria-label", "설정 열기");

  const teeth = [0, 45, 90, 135, 180, 225, 270, 315]
    .map((a) => `<rect x="7.1" y="0.6" width="1.8" height="3.3" rx="0.8" transform="rotate(${a} 8 8)"/>`)
    .join("");
  btn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <g fill="currentColor">${teeth}</g>
      <circle cx="8" cy="8" r="4.9" fill="none" stroke="currentColor" stroke-width="1.7"/>
      <circle cx="8" cy="8" r="1.9" fill="currentColor"/>
    </svg>`;

  // 플레이트의 mouseup(= 상세 토글)까지 올라가지 않게 막는다.
  btn.addEventListener("mouseup", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.usage.openSettings();
  });
  return btn;
}

function ensureStructure() {
  if (built && cells.size) return;
  cells.clear();
  plate.replaceChildren();
  plate.classList.remove("empty");
  for (const name of PROVIDER_ORDER) plate.appendChild(buildCell(name));
  plate.appendChild(gearButton());
  built = true;
}

/* ------------------------------------------------------------------ *
 * 값 쓰기
 * ------------------------------------------------------------------ */

function applyRow(ref, key, provider) {
  const w = provider?.[key];
  const lv = level(w?.leftPercent ?? 100, severityFor(provider, key));
  ref.row.className = w ? `row lv-${lv}` : "row absent";

  ref.fill.style.width = `${w ? w.leftPercent : 0}%`;
  ref.pc.textContent = w ? `${w.leftPercent}%` : "--";

  // Ultra는 5시간 한도가 없다. 값을 못 받은 것과 한도가 없는 것은 다르다.
  const noLimit = key === "session" && provider?.plan === "Ultra";
  ref.rs.textContent = w ? w.resetCountdown : (noLimit ? "한도 없음" : "데이터 없음");

  ref.row.title = w
    ? `${WINDOW_NAMES[key]} ${w.leftPercent}% 남음 · ${w.resetCountdown} 뒤 초기화`
      + (w.forecast?.ratePerHour ? ` · 시간당 ${w.forecast.ratePerHour}%` : "")
    : `${WINDOW_NAMES[key]} ${noLimit ? "한도 없음" : "데이터 없음"}`;
}

function applyCell(name, provider) {
  const ref = cells.get(name);
  if (!ref) return;

  ref.cell.classList.toggle("stale", provider?.status === "stale");
  ref.cell.classList.toggle("error", !provider || provider.status === "error");
  ref.dot.hidden = provider?.status === "ready";

  ref.plan.textContent = provider?.plan ? shortPlan(provider.plan) : "";
  ref.plan.title = provider?.plan ?? "";
  ref.logo.title = PROVIDER_NAMES[name] ?? name;

  for (const key of ROW_KEYS) applyRow(ref.refs[key], key, provider);
}

function render(state) {
  const { report, config } = state;
  plate.classList.toggle("locked", !!config?.locked);
  // 바탕색 알파만 바꾼다. 요소 전체 opacity를 쓰면 글자까지 흐려진다.
  if (config?.opacity) plate.style.setProperty("--plate-alpha", String(config.opacity));

  if (!report?.providers?.length) {
    cells.clear();
    built = false;
    plate.classList.add("empty");
    plate.textContent = "조회 중";
    return;
  }

  ensureStructure();
  for (const name of PROVIDER_ORDER) applyCell(name, pickProvider(report, name));
}

/* ------------------------------------------------------------------ *
 * 입력
 * ------------------------------------------------------------------ */

// 플레이트 전체가 드래그 영역이다. 마우스를 뗀 시점에 창이 움직이지 않았으면
// 클릭으로 보고 팝업을 연다. 드래그 판정은 메인이 창 좌표를 비교해서 한다.
plate.addEventListener("mouseup", (e) => {
  if (e.button === 0) window.usage.mouseUp();
});
plate.addEventListener("dblclick", () => window.usage.mouseUp());

/*
 * 붙잡기 신호.
 *
 * 메인은 커서 좌표를 직접 보지만 누름 여부는 여기서만 알 수 있다.
 * 드래그와 클릭을 가리는 데 쓴다.
 */
let hovering = false;
let pressing = false;
const sendHold = () => window.usage.setHold({ hover: hovering, press: pressing });

plate.addEventListener("mouseenter", () => { hovering = true; sendHold(); });
plate.addEventListener("mouseleave", () => { hovering = false; sendHold(); });
plate.addEventListener("mousedown", (e) => { if (e.button === 0) { pressing = true; sendHold(); } });
document.addEventListener("mouseup", () => { pressing = false; sendHold(); });
window.addEventListener("blur", () => { hovering = false; pressing = false; sendHold(); });

window.usage.onState(render);

// 작업표시줄을 따라 사라지고 나타날 때. 창 투명도(setOpacity)를 transparent 창에
// 걸면 Windows에서 알파가 깨지므로 여기서 흐린다.
window.usage.onWidgetVisible((visible) => plate.classList.toggle("gone", !visible));

window.usage.onSettled(() => {
  plate.classList.add("settled");
  setTimeout(() => plate.classList.remove("settled"), 320);
});

window.usage.getState().then((state) => {
  render(state);
  if (!reduceMotion) plate.classList.add("entering");   // 한 번만 하는 등장
});
