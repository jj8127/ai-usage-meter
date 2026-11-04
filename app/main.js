import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, screen, shell, Notification } from "electron";

import {
  collectAll, createCache, loadCache, saveCache,
  loadForecastState, saveForecastState,
  trackWindow, forecast, formatHours,
  collectAlerts, alertText, DEFAULT_THRESHOLDS,
} from "../src/index.js";
import { PROVIDER_NAMES, WINDOW_NAMES } from "./shared.js";
import {
  SCALES, CLAUDE_PLANS, widgetSize, readConfig, writeConfig, configPath,
  restorePosition, clampToDisplay,
} from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// 설정까지 스크롤 없이 보이는 높이. 설정을 보려고 굴려야 하면 설정이 아니라 숨긴 것이다.
const POPUP_SIZE = { width: 384, height: 700 };

// 배율 선택지. 트레이 메뉴와 설정 창이 같은 이름을 쓴다.
const SCALE_LABELS = [[0.7, "아주 작게"], [0.85, "작게"], [1, "보통"], [1.15, "크게"]];
/** 창이 이 시간 안에 움직였으면 클릭이 아니라 드래그로 본다. */
/** 이보다 적게 움직였으면 손떨림으로 보고 클릭으로 친다. */
const DRAG_SLOP_PX = 3;

let config = readConfig();
let widget = null;
let popup = null;
let tray = null;
let report = null;
let pollTimer = null;
let lastMovedAt = 0;
let movedCount = 0;
let saveTimer = null;
// 메인 프로세스에는 matchMedia가 없다. 렌더러에 한 번 물어 두고 창 페이드에 쓴다.
let reduceMotion = false;

// 개발용 플래그로 도는 중인가. 이때는 작업표시줄을 따라 숨지 않는다.
// 숨은 작업표시줄에 맞춰 위젯이 사라지면 캡처도 점검도 할 수 없다.
const IS_DEV_RUN = ["--shot", "--movetest", "--clicktest", "--motiontest", "--tbtest", "--ztest", "--scaletest", "--holdtest"]
  .some((f) => process.argv.includes(f));

const cache = createCache();

/* ------------------------------------------------------------------ *
 * 수집
 * ------------------------------------------------------------------ */

async function refresh() {
  // 조회가 통째로 실패해도 앱은 돌아가야 한다. 예외를 그냥 던지면 폴링 한 번이
  // 죽는 데 그치지 않고, 직전 보고서가 손질되지 않은 채로 남는다(플랜 지정이
  // 적용되지 않아 Ultra가 Max로 보였다).
  let next;
  try {
    next = await collectAll(cache);
  } catch (err) {
    if (SYNC_TRACE) console.log(`[refresh] 조회 실패: ${err?.message ?? err}`);
    return;
  }
  report = next;
  applyPlanOverride(report);
  applyForecasts(report);
  saveCache(cache);
  broadcast();
}

/** 사용자가 플랜을 직접 골랐으면 그 값을 쓴다. 토큰에 박힌 값보다 사용자가 정확하다. */
function applyPlanOverride(rep) {
  const pick = config.claudePlan;
  if (!pick || pick === "auto") return;
  const claude = rep?.providers?.find((p) => p.provider === "claude");
  if (claude) claude.plan = pick;
}

/* ------------------------------------------------------------------ *
 * 소비 속도 예측과 알림
 * ------------------------------------------------------------------ */

/** 창별 표본과 "이미 울린 알림" 기록. 껐다 켜도 이어지도록 파일에 남긴다. */
let forecastState = { series: {}, fired: {} };

/**
 * 각 창에 예측을 붙이고, 필요하면 알린다.
 *
 * 잔여 %만으로 소비 기울기를 구한다. 새 API도 새 권한도 필요 없다.
 * 알림이 필요한 이유: 위젯이 작업표시줄을 따라 숨으므로 색 경고를 볼 기회가 거의 없다.
 */
function applyForecasts(rep) {
  if (!rep?.providers) return;
  const now = Date.now();

  for (const p of rep.providers) {
    const windows = [];
    for (const key of ["session", "weekly"]) {
      const w = p[key];
      if (!w) continue;
      const sk = `${p.provider}:${key}`;
      forecastState.series[sk] = trackWindow(forecastState.series[sk], w, now);
      w.forecast = forecast(forecastState.series[sk], w, key, now);
      windows.push({ key, window: w, forecast: w.forecast });
    }

    if (config.notify !== false) {
      const { alerts, fired } = collectAlerts(forecastState.fired, {
        provider: p.provider,
        windows,
        thresholds: config.notifyThresholds ?? DEFAULT_THRESHOLDS,
      });
      forecastState.fired = fired;
      for (const a of alerts) notify(a, windows.find((w) => w.key === a.windowKey)?.window);
    }
  }
  saveForecastState(forecastState);
}

/**
 * 시험 알림.
 *
 * Windows는 집중 지원이나 앱별 알림 설정으로 알림을 **조용히 막는다.** 한도가
 * 25% 아래로 내려가는 순간까지 기다려서야 "안 떴다"를 알게 되면 늦다.
 * 지금 눌러서 확인할 수 있어야 한다.
 */
function notifyTest() {
  return showNotice("AI Usage Meter · 알림 시험", "이 알림이 보이면 한도 임박 알림도 뜹니다.");
}

/* ------------------------------------------------------------------ *
 * 알림 창 (직접 그린다)
 * ------------------------------------------------------------------ */

/*
 * Windows 토스트를 쓰지 않는 이유.
 *
 * 시작 메뉴 바로가기에 AppUserModelID(dev.jj812.ai-usage-meter)가 제대로 박혀
 * 있는 것을 .lnk 파일에서 확인했고, Electron을 거치지 않고 Windows API로 직접
 * 토스트를 쏴 봤는데도 알림 DB(wpndatabase)에 이 앱 핸들러가 **한 건도** 생기지
 * 않았다(전체 413개 중 0). 예외도 없이 조용히 사라진다. 트레이 풍선도 같았다.
 *
 * 끊김을 막겠다는 기능이 OS 사정으로 안 뜨면 아무 의미가 없다. 그래서 직접 그린다.
 * 덤으로 집중 지원에 묻히지 않고, 위젯과 같은 디자인을 쓴다.
 */

const NOTICE_SIZE = { width: 334, height: 74 };
const NOTICE_MS = 9000;

let noticeWin = null;
let noticeTimer = null;
let noticeHeld = false;
const noticeQueue = [];

function createNoticeWindow() {
  noticeWin = new BrowserWindow({
    ...NOTICE_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,          // 작업 중에 포커스를 빼앗지 않는다
    show: false,
    title: "AI Usage 알림",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  noticeWin.setAlwaysOnTop(true, "screen-saver");
  noticeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  noticeWin.loadFile(path.join(here, "notice.html"));
  noticeWin.on("closed", () => { noticeWin = null; });
}

/** 주 화면 오른쪽 아래. 작업 영역 안에 둬서 작업표시줄과 겹치지 않게 한다. */
function placeNotice() {
  const { workArea } = screen.getPrimaryDisplay();
  noticeWin.setBounds({
    x: workArea.x + workArea.width - NOTICE_SIZE.width - 16,
    y: workArea.y + workArea.height - NOTICE_SIZE.height - 16,
    ...NOTICE_SIZE,
  });
}

/**
 * 알림을 띄운다. 이미 하나가 떠 있으면 줄을 세운다.
 * 한꺼번에 겹쳐 띄우면 뒤엣것이 앞엣것을 가린다.
 */
function showNotice(title, body, meta = {}) {
  noticeQueue.push({ title, body, ...meta });
  if (!noticeTimer) drainNotice();
  return true;
}

function drainNotice() {
  const item = noticeQueue.shift();
  if (!item) return;
  if (!noticeWin || noticeWin.isDestroyed()) createNoticeWindow();

  const send = () => {
    placeNotice();
    noticeWin.showInactive();
    noticeWin.webContents.send("notice", item);
    armNoticeTimer();
  };
  if (noticeWin.webContents.isLoading()) {
    noticeWin.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function armNoticeTimer() {
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeTimer = null;
    if (noticeHeld) { armNoticeTimer(); return; }   // 읽는 중이면 기다린다
    hideNotice();
  }, NOTICE_MS);
}

function hideNotice() {
  if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  if (noticeWin && !noticeWin.isDestroyed()) noticeWin.hide();
  if (noticeQueue.length) setTimeout(drainNotice, 250);
}

function notify(alert, window) {
  const { title, body } = alertText(alert, {
    providerName: PROVIDER_NAMES[alert.provider] ?? alert.provider,
    windowName: WINDOW_NAMES[alert.windowKey] ?? alert.windowKey,
    resetCountdown: window?.resetCountdown ?? null,
    formatHours,
  });
  showNotice(title, body, {
    provider: alert.provider,
    level: alert.kind === "runout" || alert.leftPercent <= 10 ? "crit" : "warn",
  });
}

function broadcast() {
  const state = { report, config: publicConfig() };
  for (const win of [widget, popup]) {
    if (win && !win.isDestroyed()) win.webContents.send("state", state);
  }
}

function publicConfig() {
  return {
    scale: config.scale,
    scales: SCALES,
    claudePlan: config.claudePlan,
    claudePlans: CLAUDE_PLANS,
    intervalSec: config.intervalSec,
    locked: config.locked,
    followTaskbar: config.followTaskbar !== false,
    notify: config.notify !== false,
    opacity: config.opacity,
    // 토글의 진실은 OS에 있다. 우리가 저장한 값이 아니라 실제 설정을 돌려준다.
    openAtLogin: actualOpenAtLogin(),
    configPath: configPath(),
  };
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => { refresh(); }, Math.max(15, config.intervalSec) * 1000);
}

/* ------------------------------------------------------------------ *
 * 설정 저장
 * ------------------------------------------------------------------ */

function persist(patch = {}) {
  config = { ...config, ...patch };
  if (saveTimer) clearTimeout(saveTimer);
  // 드래그 중에는 moved가 연달아 오므로 묶어서 한 번만 적는다.
  saveTimer = setTimeout(() => writeConfig(config), 400);
}

/* ------------------------------------------------------------------ *
 * 부팅 시 자동 실행
 * ------------------------------------------------------------------ */

/**
 * 패키징 전에는 실행 파일이 electron.exe라서, 인자 없이 등록하면 부팅 때
 * 빈 Electron이 뜬다. 그래서 등록할 때 이 앱의 진입 스크립트를 인자로 함께 넣는다.
 * 그 덕에 빌드하기 전에도 자동 실행이 실제로 동작한다.
 */
function loginItemSpec(enabled) {
  return {
    openAtLogin: enabled,
    path: process.execPath,
    args: app.isPackaged ? [] : [path.join(here, "main.js")],
  };
}

/** 토글의 진실은 OS에 있다. 우리가 저장한 값이 아니라 실제 등록 상태를 읽는다. */
function actualOpenAtLogin() {
  return app.getLoginItemSettings(loginItemSpec(true)).openAtLogin;
}

function setOpenAtLogin(enabled) {
  app.setLoginItemSettings(loginItemSpec(enabled));
  const actual = actualOpenAtLogin();
  persist({ openAtLogin: actual });
  return actual;
}

/* ------------------------------------------------------------------ *
 * 위젯 창
 * ------------------------------------------------------------------ */

function createWidget() {
  const size = widgetSize(config);
  const { x, y, clamped } = restorePosition(config, size);

  widget = new BrowserWindow({
    x, y,
    ...size,
    frame: false,
    transparent: true,
    resizable: false,
    movable: !config.locked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 클릭을 DOM까지 전달하려면 focusable이어야 한다.
    focusable: true,
    show: false,
    title: "AI Usage",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  widget.setAlwaysOnTop(true, "screen-saver");
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.loadFile(path.join(here, "widget.html"));

  widget.once("ready-to-show", async () => {
    // 작업표시줄을 따라갈 참이면 첫 판정이 올 때까지 아예 띄우지 않는다. 먼저
    // 띄우면 숨어 있는 작업표시줄에 맞춰 곧장 사라지면서 켤 때마다 한 번 번쩍인다.
    const waitForTaskbar = !IS_DEV_RUN
      && config.followTaskbar !== false && process.platform === "win32";
    applyZoom();                                  // 저장된 배율을 적용하고 띄운다
    if (!waitForTaskbar) widget.showInactive();   // 포커스를 훔치지 않는다
    if (clamped) persist({ x, y });               // 화면 밖이었으면 되돌린 좌표를 저장
    broadcast();

    // 감시가 끝내 답하지 않으면 숨은 채로 두지 않는다.
    if (waitForTaskbar) {
      setTimeout(() => { if (!taskbarReadingSeen) applyTaskbarState(true); }, 1500);
    }
    reduceMotion = await widget.webContents
      .executeJavaScript(`matchMedia("(prefers-reduced-motion: reduce)").matches`)
      .catch(() => false);
  });

  // 드래그가 끝나면 좌표를 저장하고, 플레이트에 "자리 잡았다"는 신호를 보낸다.
  widget.on("moved", () => {
    movedCount++;
    lastMovedAt = Date.now();
    enforceBounds();
    // 창이 움직였다는 건 끌고 있다는 뜻이다. 그 직전에 숨기기로 결정됐더라도
    // 되살린다. moved가 판단보다 늦게 오면 끌던 창이 사라진 채로 남는다.
    syncWidgetVisibility();
    widget.webContents.send("settled");
  });

  widget.on("closed", () => { widget = null; });
}

/**
 * 창을 제자리·제크기로 되돌리고 좌표를 저장한다.
 *
 * 크기까지 매번 다시 지정하는 이유: 배율이 다른 모니터가 섞여 있으면(이 PC는 1.75와
 * 1.25) 창을 옮길 때마다 Windows가 크기를 다시 계산해서 높이가 46 → 50 → 53으로
 * 조금씩 커진다. resizable: false로는 막히지 않는다. 그래서 위치와 크기를 한 번에
 * setBounds로 못 박는다.
 *
 * 값이 이미 맞으면 아무것도 하지 않는다. 그래야 moved → setBounds → moved 고리가
 * 한 번에 멈춘다.
 */
function enforceBounds() {
  if (!widget || widget.isDestroyed()) return;
  const size = widgetSize(config);
  const now = widget.getBounds();
  const want = { ...clampToDisplay(now, size), ...size };

  if (now.x !== want.x || now.y !== want.y || now.width !== want.width || now.height !== want.height) {
    widget.setBounds(want);
  }
  if (SYNC_TRACE) console.log(`[bounds] now=${now.x},${now.y} ${now.width}x${now.height} -> want=${want.x},${want.y} ${want.width}x${want.height}`);
  persist({ x: want.x, y: want.y });
}

/**
 * 위젯 배율을 바꾼다.
 *
 * px 값을 하나하나 줄이는 대신 페이지 확대율(setZoomFactor)과 창 크기에 같은 수를
 * 곱한다. 글자·막대·여백 비율이 그대로 유지되고 고칠 CSS가 없다.
 */
function setScale(value) {
  const next = Number(value);
  if (!SCALES.includes(next) || next === config.scale) return config.scale;
  persist({ scale: next });
  applyZoom();
  enforceBounds();
  renderTrayMenu();
  broadcast();
  return config.scale;
}

function applyZoom() {
  if (!widget || widget.isDestroyed()) return;
  widget.webContents.setZoomFactor(config.scale ?? 1);
}


/* ------------------------------------------------------------------ *
 * 작업표시줄 따라가기
 * ------------------------------------------------------------------ */

let taskbarWatcher = null;
let taskbarShown = true;
let taskbarReadingSeen = false;
let fadeTimer = null;

/**
 * 작업표시줄이 보이는지 감시하는 보조 프로세스를 띄운다.
 *
 * Node에서 Win32를 직접 부를 수 없어 PowerShell 한 개를 상주시키고 상태가 바뀔 때만
 * 한 줄을 받는다. 200ms마다 창 위치만 읽으므로 부담이 거의 없다.
 */
function startTaskbarWatcher() {
  if (process.platform !== "win32" || taskbarWatcher) return;
  const root = process.env.SystemRoot;
  const ps = root
    ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";

  // 묶인 앱에서는 이 스크립트가 app.asar 밖으로 빠져 나온다(asarUnpack). 외부
  // 프로세스는 asar 안을 읽을 수 없으므로 경로를 꺼낸 쪽으로 바꿔 줘야 한다.
  const script = path.join(here, "taskbar-watch.ps1").replace("app.asar", "app.asar.unpacked");

  taskbarWatcher = spawn(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );

  let buffer = "";
  taskbarWatcher.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (SYNC_TRACE) console.log(`[tb] 감시 응답 ${JSON.stringify(t)}`);
      if (t === "0" || t === "1") applyTaskbarState(t === "1");
    }
  });

  // 감시가 죽으면 위젯이 숨은 채로 남는 편보다 보이는 편이 낫다.
  taskbarWatcher.on("exit", () => {
    taskbarWatcher = null;
    applyTaskbarState(true);
  });
  taskbarWatcher.on("error", () => { taskbarWatcher = null; applyTaskbarState(true); });
}

function stopTaskbarWatcher() {
  if (!taskbarWatcher) return;
  const child = taskbarWatcher;
  taskbarWatcher = null;
  child.kill();
}

function applyTaskbarState(shown) {
  taskbarReadingSeen = true;
  const rising = shown && !taskbarShown;
  taskbarShown = shown;
  syncWidgetVisibility();
  // 따라가기를 꺼 둔 경우 위젯은 이미 떠 있으므로 보임 전환이 일어나지 않는다.
  // 그때도 작업표시줄이 올라오는 순간에 다시 올려 줘야 가려지지 않는다.
  if (rising) raiseBurst();
}

/*
 * 붙잡기(hold).
 *
 * 마우스를 올려 두었거나 끌고 있는 동안에는 작업표시줄이 내려가도 위젯을 숨기지
 * 않는다. 위젯을 끌어 아래 가장자리를 벗어나면 작업표시줄이 바로 내려가는데,
 * 그때 위젯까지 사라지면 드래그가 끊긴다. 마우스를 올린 채로 읽고 있을 때도 같다.
 */
let holding = false;            // 렌더러가 알려주는 호버·누름 상태
let holdSince = 0;
let visibilityRecheck = null;

const DRAG_HOLD_MS = 1200;      // 마지막 이동 직후 이 시간 동안은 드래그 중으로 본다
const HOLD_CAP_MS = 120_000;    // mouseleave를 놓쳤을 때 영원히 붙잡히지 않게 하는 상한

let pressing = false;
let pressBounds = null;

/**
 * 렌더러가 알려주는 호버·누름 상태.
 * 누르기 시작한 순간의 창 위치를 적어 둔다. 손을 뗄 때 그 자리와 비교해
 * 끌었는지 클릭인지 가린다.
 */
function setHold(state) {
  const press = !!state?.press;

  // 누름은 드래그·클릭을 가리는 데만 쓴다. 보임 여부는 폴링이 정한다.
  if (press && !pressing) {
    pressing = true;
    if (widget && !widget.isDestroyed()) pressBounds = widget.getBounds();
  } else if (!press) {
    pressing = false;
  }
  syncWidgetVisibility();
}

/*
 * 붙잡기 판단은 DOM 마우스 이벤트에 기대지 않는다.
 *
 * 플레이트 전체가 -webkit-app-region: drag 라서 드래그를 OS가 가져간다. 그동안
 * 렌더러에는 mousedown / mousemove / mouseleave 가 오지 않는다. 그래서 메인에서
 * 커서 좌표와 창 좌표를 직접 들여다본다. 이벤트가 오든 안 오든 똑같이 동작한다.
 */
const SYNC_TRACE = process.argv.includes("--trace");
const POLL_MS = 120;
let pollTimerId = null;
let lastBoundsKey = "";
let cursorOver = false;

function startInteractionPoll() {
  if (pollTimerId) return;
  lastBoundsKey = "";
  pollTimerId = setInterval(pollInteraction, POLL_MS);
}

function stopInteractionPoll() {
  if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
  cursorOver = false;
}

function pollInteraction() {
  if (!widget || widget.isDestroyed() || !widget.isVisible()) return;
  const b = widget.getBounds();

  // 창이 움직였으면 끌고 있는 것이다. moved 이벤트는 이 환경에서 오지 않는다.
  const key = `${b.x},${b.y}`;
  const moved = lastBoundsKey !== "" && key !== lastBoundsKey;
  lastBoundsKey = key;
  if (moved) lastMovedAt = Date.now();

  // 커서가 위젯 위에 있는지도 직접 본다. 가장자리에서 깜박이지 않게 여유를 둔다.
  const p = screen.getCursorScreenPoint();
  const m = 2;
  const over = p.x >= b.x - m && p.x <= b.x + b.width + m
    && p.y >= b.y - m && p.y <= b.y + b.height + m;

  if (over !== cursorOver || moved) {
    cursorOver = over;
    syncWidgetVisibility();   // 숨기는 중이었다면 여기서 되돌아온다
  }
}

/**
 * 지금 위젯을 붙잡아 둬야 하는가.
 *
 * DOM 마우스 이벤트는 쓰지 않는다. 실측해 보니 창을 커서 아래로 옮기면
 * mouseenter는 오는데 치울 때 mouseleave가 오지 않아, 한 번 켜진 플래그가
 * 풀리지 않는다. app-region 드래그가 이벤트를 가져가기 때문이다.
 * 커서 좌표와 창 좌표만 보면 켜짐·꺼짐이 항상 맞는다.
 */
function isHeld() {
  if (cursorOver) return true;                                // 마우스가 위젯 위
  if (Date.now() - lastMovedAt < DRAG_HOLD_MS) return true;   // 끌고 있는 중
  // 상세·설정 창이 열려 있으면 위젯도 남겨 둔다. 설정을 만지는 중에 아래쪽 띠가
  // 사라지면 무엇을 바꾸고 있는지 보이지 않는다.
  if (popup && !popup.isDestroyed() && popup.isVisible()) return true;
  return false;
}

/** 따라가기가 꺼져 있으면 언제나 보인다. */
function syncWidgetVisibility() {
  if (!widget || widget.isDestroyed()) return;
  const want = config.followTaskbar === false ? true : taskbarShown;
  if (want) { fadeWidgetIn(); return; }

  if (isHeld()) {
    // 이미 사라지는 중이었다면 되돌린다. 그냥 return만 하면 앞서 걸어 둔 숨김
    // 타이머가 그대로 터져, 붙잡고 있는데도 창이 사라진다.
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    if (widget.isVisible()) widget.webContents.send("widget-visible", true);

    // 붙잡기가 풀리면 숨겨야 하므로 다시 보러 온다.
    if (!visibilityRecheck) {
      visibilityRecheck = setTimeout(() => {
        visibilityRecheck = null;
        syncWidgetVisibility();
      }, 400);
    }
    if (SYNC_TRACE) console.log(`[sync] 붙잡음 cursorOver=${cursorOver} move전=${Date.now() - lastMovedAt}ms 재검사예약=${!!visibilityRecheck}`);
    return;
  }
  if (SYNC_TRACE) console.log("[sync] 숨김 실행");
  fadeWidgetOut();
}

/**
 * 서서히 보이고 감춘다. 페이드는 창이 아니라 **렌더러 안에서** 한다.
 *
 * BrowserWindow.setOpacity()를 쓰면 안 된다. transparent: true 창에 창 투명도를
 * 걸면 Windows에서 per-pixel 알파가 깨져, 투명해야 할 둥근 모서리까지 회색으로
 * 차고 내용이 흐려진다. 화면에는 "내용 없는 회색 상자"로 보인다.
 * 그래서 플레이트의 CSS opacity만 바꾸고, 다 사라진 뒤에 창을 숨긴다.
 */
const FADE_MS = 320;

let stayTopTimer = null;

/**
 * 자신을 최상위로 계속 다시 올린다.
 *
 * 자동 숨김 작업표시줄은 미끄러져 나올 때마다 **스스로를 topmost로 다시 세운다.**
 * alwaysOnTop을 걸어 둔 것만으로는 그 아래로 깔려, 위젯 윗부분만 빼꼼 보인다.
 * 그래서 보이는 동안 주기적으로 다시 올린다. 작업표시줄이 올라오는 순간을 놓치지
 * 않도록 보일 때 한 번 몰아서도 올린다.
 */
function startStayTop() {
  raiseBurst();
  if (stayTopTimer) return;
  stayTopTimer = setInterval(raise, 500);
}

function stopStayTop() {
  if (stayTopTimer) { clearInterval(stayTopTimer); stayTopTimer = null; }
}

function raise() {
  if (!widget || widget.isDestroyed() || !widget.isVisible()) return;
  widget.setAlwaysOnTop(true, "screen-saver");
  widget.moveTop();
}

/** 작업표시줄이 미끄러져 나오는 동안(약 0.3초) 여러 번 올려 둔다. */
function raiseBurst() {
  for (const delay of [0, 80, 180, 320, 520]) setTimeout(raise, delay);
}

function fadeWidgetIn() {
  if (SYNC_TRACE) console.log("[sync] 보임 실행");
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  if (!widget.isVisible()) widget.showInactive();
  widget.webContents.send("widget-visible", true);
  startStayTop();
  startInteractionPoll();
}

function fadeWidgetOut() {
  if (!widget.isVisible()) return;
  stopStayTop();
  stopInteractionPoll();
  widget.webContents.send("widget-visible", false);
  if (fadeTimer) clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    if (widget && !widget.isDestroyed()) widget.hide();
  }, reduceMotion ? 0 : FADE_MS);
}

/* ------------------------------------------------------------------ *
 * 상세 팝업
 * ------------------------------------------------------------------ */

function createPopup() {
  popup = new BrowserWindow({
    ...POPUP_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    title: "AI Usage 상세",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popup.setAlwaysOnTop(true, "screen-saver");
  popup.loadFile(path.join(here, "popup.html"));
  // 창이 뜰 때마다 들어오는 동작을 다시 보여준다. 창 자체는 애니메이션할 수 없으므로
  // 안의 시트가 대신 움직인다.
  popup.on("show", () => popup?.webContents.send("popup-shown"));
  popup.on("blur", () => popup?.hide());
  popup.on("hide", () => {
    popupHiddenAt = Date.now();
    // 팝업이 닫히면 위젯을 계속 붙잡을 이유가 없어진다. 다시 판단한다.
    syncWidgetVisibility();
  });
  popup.on("closed", () => { popup = null; });
}

/** 위젯 위/아래 중 화면에 들어가는 쪽에 붙인다. */
function placePopup() {
  if (!popup || !widget) return;
  const w = widget.getBounds();
  const area = screen.getDisplayMatching(w).workArea;

  let x = Math.round(w.x + w.width / 2 - POPUP_SIZE.width / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - POPUP_SIZE.width - 8));

  const above = w.y - POPUP_SIZE.height - 10;
  const y = above >= area.y + 8 ? above : Math.min(w.y + w.height + 10, area.y + area.height - POPUP_SIZE.height - 8);
  popup.setPosition(x, y);
}

/**
 * 방금 blur로 닫혔는가.
 *
 * 위젯을 누르면 팝업이 포커스를 잃어 blur -> hide 가 먼저 일어나고, 그 뒤에 버튼
 * 신호가 도착한다. 그대로 두면 "열려 있지 않다"고 보고 다시 열어 버려서, 닫으려고
 * 누른 것이 깜빡이고 마는다. 직전에 닫혔으면 닫는 동작으로 친다.
 */
const REOPEN_GUARD_MS = 320;
let popupHiddenAt = 0;

function popupJustClosed() {
  return Date.now() - popupHiddenAt < REOPEN_GUARD_MS;
}

function togglePopup() {
  if (!popup || popup.isDestroyed()) createPopup();
  if (popup.isVisible() || popupJustClosed()) { popup.hide(); return; }
  showPopup();
}

function showPopup() {
  if (!popup || popup.isDestroyed()) createPopup();
  placePopup();
  popup.show();
  popup.focus();
  broadcast();
}

/** 설정 버튼은 토글이다. 열려 있으면 닫고, 닫혀 있으면 열면서 설정 쪽을 짚어 준다. */
function openSettings() {
  if (!popup || popup.isDestroyed()) createPopup();
  if (popup.isVisible() || popupJustClosed()) { popup.hide(); return; }
  showPopup();

  // 아직 로딩 중이면 보내도 받을 쪽이 없어 조용히 사라진다. 다 읽은 뒤에 보낸다.
  if (popup.webContents.isLoading()) {
    popup.webContents.once("did-finish-load", () => popup?.webContents.send("focus-settings"));
  } else {
    popup.webContents.send("focus-settings");
  }
}

/* ------------------------------------------------------------------ *
 * 트레이
 * ------------------------------------------------------------------ */

/**
 * 트레이 아이콘.
 *
 * nativeImage는 **SVG를 읽지 못한다** (PNG/JPEG만 된다). SVG 데이터 URL을 넘기면
 * 예외 없이 빈 이미지가 돌아오고, 트레이에는 아무것도 없는 회색 칸만 남는다.
 *
 * PNG를 쓰고 @2x·@3x를 같은 폴더에 둔다. nativeImage가 화면 배율에 맞는 것을
 * 골라 쓴다. 각 크기를 그 크기에서 직접 그렸기 때문에 16px에서도 뭉개지지 않는다.
 */
function trayIcon() {
  const file = path.join(here, "icons", "tray.png");
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    // 조용히 빈 칸으로 두지 않는다. 눈으로만 확인하면 놓치는 종류의 고장이다.
    console.error(`[Tray] 아이콘을 읽지 못했습니다: ${file}`);
  }
  return image;
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("AI Usage");
  tray.on("click", () => togglePopup());
  renderTrayMenu();
}

function renderTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "상세 보기", click: () => togglePopup() },
    { label: "지금 새로고침", click: () => refresh() },
    { type: "separator" },
    {
      label: "위젯 크기",
      submenu: SCALE_LABELS.map(([value, label]) => ({
        label,
        type: "radio",
        checked: config.scale === value,
        click: () => setScale(value),
      })),
    },
    {
      label: "위치 잠금",
      type: "checkbox",
      checked: config.locked,
      click: (item) => setLocked(item.checked),
    },
    {
      label: "한도 임박 알림",
      type: "checkbox",
      checked: config.notify !== false,
      click: (item) => setNotify(item.checked),
    },
    { label: "알림 시험", click: () => notifyTest() },
    {
      label: "작업표시줄 따라 숨기기",
      type: "checkbox",
      checked: config.followTaskbar !== false,
      click: (item) => setFollowTaskbar(item.checked),
    },
    {
      label: "윈도우 시작 시 자동 실행",
      type: "checkbox",
      checked: actualOpenAtLogin(),
      click: (item) => { setOpenAtLogin(item.checked); renderTrayMenu(); broadcast(); },
    },
    { type: "separator" },
    { label: "설정 파일 열기", click: () => shell.showItemInFolder(configPath()) },
    { label: "종료", click: () => app.quit() },
  ]));
}

function setLocked(locked) {
  persist({ locked });
  widget?.setMovable(!locked);
  renderTrayMenu();
  broadcast();
}

function setNotify(on) {
  persist({ notify: on });
  renderTrayMenu();
  broadcast();
  return config.notify !== false;
}

function setFollowTaskbar(follow) {
  persist({ followTaskbar: follow });
  syncWidgetVisibility();
  renderTrayMenu();
  broadcast();
  return config.followTaskbar !== false;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  ipcMain.handle("get-state", () => ({ report, config: publicConfig() }));
  ipcMain.handle("refresh", async () => { await refresh(); return report; });
  ipcMain.handle("set-open-at-login", (_e, enabled) => {
    const actual = setOpenAtLogin(!!enabled);
    renderTrayMenu();
    return actual;
  });
  ipcMain.handle("set-locked", (_e, locked) => { setLocked(!!locked); return config.locked; });
  ipcMain.handle("set-scale", (_e, value) => setScale(value));
  ipcMain.handle("set-claude-plan", (_e, v) => {
    if (!CLAUDE_PLANS.includes(v)) return config.claudePlan;
    persist({ claudePlan: v });
    applyPlanOverride(report);
    broadcast();
    return config.claudePlan;
  });
  ipcMain.handle("set-follow-taskbar", (_e, follow) => setFollowTaskbar(!!follow));
  ipcMain.handle("set-notify", (_e, on) => setNotify(!!on));
  ipcMain.handle("set-interval", (_e, sec) => {
    const n = Math.max(15, Math.min(600, Number(sec) || 60));
    persist({ intervalSec: n });
    startPolling();
    broadcast();
    return n;
  });

  // 위젯에서 마우스를 뗐다. 그 직전에 창이 움직였으면 드래그였으므로 팝업을 열지 않는다.
  ipcMain.on("widget-mouseup", () => {
    // 끌었는지 클릭인지는 'moved' 이벤트가 아니라 **좌표를 직접 비교**해 가린다.
    // 이 환경에서는 창을 옮겨도 moved가 오지 않아(실측: 누적 0회) 이벤트에 기대면
    // 드래그가 전부 클릭으로 잡혀 손을 뗄 때마다 팝업이 열린다.
    const now = widget && !widget.isDestroyed() ? widget.getBounds() : null;
    const movedFromPress = pressBounds && now
      && (Math.abs(now.x - pressBounds.x) > DRAG_SLOP_PX
        || Math.abs(now.y - pressBounds.y) > DRAG_SLOP_PX);
    // 누름 이벤트가 오지 않는 경우까지 대비해, 폴링이 본 최근 움직임도 함께 본다.
    const justMoved = Date.now() - lastMovedAt < 400;
    const dragged = movedFromPress || justMoved;
    pressBounds = null;

    if (dragged) {
      enforceBounds();                      // 끝난 자리를 저장하고 화면 안으로 넣는다
      widget.webContents.send("settled");
      return;
    }
    togglePopup();
  });

  ipcMain.on("widget-hold", (_e, value) => setHold(value));
  ipcMain.on("notice-click", () => { hideNotice(); openSettings(); });
  ipcMain.on("notice-close", () => hideNotice());
  ipcMain.on("notice-hold", (_e, v) => { noticeHeld = !!v; });
  ipcMain.on("open-settings", () => openSettings());
  ipcMain.on("close-popup", () => popup?.hide());
  ipcMain.on("quit", () => app.quit());
}

/* ------------------------------------------------------------------ *
 * 수명 주기
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (argv.includes("--testnotify")) { notifyTest(); return; }
    widget?.showInactive();
    togglePopup();
  });

  app.whenReady().then(async () => {
    // Windows 알림은 AppUserModelID가 없으면 조용히 묻힌다.
    if (process.platform === "win32") app.setAppUserModelId("dev.jj812.ai-usage-meter");

    // 부팅 직후에도 숫자가 바로 보이게. 마지막 실측값을 먼저 올린 뒤 조회한다.
    loadCache(cache);
    forecastState = loadForecastState();
    report = await collectAll(cache);
    applyPlanOverride(report);
    applyForecasts(report);

    // 저장된 설정과 OS 등록 상태를 맞춘다. 사용자가 꺼 뒀으면 꺼진 채로 둔다.
    setOpenAtLogin(config.openAtLogin !== false);

    registerIpc();
    createWidget();
    createPopup();
    buildTray();
    startPolling();

    // 디스플레이 구성이 바뀌면 위젯이 화면 밖으로 밀릴 수 있다.
    screen.on("display-metrics-changed", enforceBounds);
    screen.on("display-removed", enforceBounds);
    screen.on("display-added", enforceBounds);
    // 배율이 바뀌는 모니터로 넘어가면 크기가 틀어진다. 리사이즈도 되돌린다.
    widget.on("resize", enforceBounds);

    await refresh();

    if (!IS_DEV_RUN) startTaskbarWatcher();
    if (process.argv.includes("--testnotify")) notifyTest();

    // --shot <폴더>: 두 미터 모양과 팝업을 캡처하고 끝낸다. 눈으로 확인하기 위한 것.
    const shotIndex = process.argv.indexOf("--shot");
    if (shotIndex !== -1) await captureAndExit(process.argv[shotIndex + 1] || ".");

    // --movetest: 창을 화면 밖으로 옮겨 보고 되돌아오는지, 좌표가 저장되는지 확인한다.
    if (process.argv.includes("--movetest")) await moveTestAndExit();

    // --clicktest: 설정 버튼을 눌러 팝업까지 이어지는지 확인한다.
    if (process.argv.includes("--clicktest")) await clickTestAndExit();

    // --motiontest: 값이 바뀔 때 숫자가 구르고 깔끔히 끝나는지 확인한다.
    if (process.argv.includes("--motiontest")) await motionTestAndExit();

    // --tbtest: 작업표시줄을 따라 숨고 나타나는지 확인한다.
    if (process.argv.includes("--tbtest")) await taskbarTestAndExit();

    // --livecheck: 평소처럼 띄운 뒤 실제로 그려진 상태를 읽는다.
    if (process.argv.includes("--livecheck")) await liveCheckAndExit();

    // --ztest: 작업표시줄보다 위에 있는지 z순서를 숫자로 잰다.
    if (process.argv.includes("--ztest")) await zOrderTestAndExit();

    // --scaletest: 배율이 창 크기와 페이지 확대율에 제대로 먹는지 본다.
    if (process.argv.includes("--scaletest")) await scaleTestAndExit();

    // --holdtest: 드래그·호버·설정창 중에는 작업표시줄이 내려가도 안 사라지는지 본다.
    if (process.argv.includes("--holdtest")) await holdTestAndExit();

    // --forecasttest: 표본이 쌓였을 때 예측·표시·알림까지 이어지는지 본다.
    if (process.argv.includes("--forecasttest")) await forecastTestAndExit();
  });

  app.on("window-all-closed", () => { /* 트레이로 남는다 */ });

  /**
   * 캡처용.
   *
   * 미터 모양을 바꿔 가며 찍으려면 config를 건드려야 하는데, 창 크기가 바뀌면
   * resize -> enforceBounds -> persist가 돌면서 그 값이 저장 파일까지 흘러간다.
   * 개발용 플래그가 사용자 설정을 바꾸면 안 되므로 원래 값으로 되돌리고 나간다.
   */
  async function captureAndExit(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    await settle(700);
    fs.writeFileSync(path.join(dir, "widget.png"),
      (await widget.webContents.capturePage()).toPNG());

    placePopup();
    popup.show();
    await settle(700);

    const shot = await popup.webContents.capturePage();
    fs.writeFileSync(path.join(dir, "popup.png"), shot.toPNG());

    // 알림 창도 찍는다. 눈으로 확인할 길이 이것뿐이다.
    showNotice("Claude 주간 9% 남음", "리셋까지 2일 3시간", { provider: "claude", level: "crit" });
    await settle(900);
    if (noticeWin && !noticeWin.isDestroyed()) {
      fs.writeFileSync(path.join(dir, "notice.png"),
        (await noticeWin.webContents.capturePage()).toPNG());
    }

    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    app.exit(0);
  }

  /**
   * 설정 버튼 경로를 눈 없이 확인한다.
   * 렌더러 클릭 -> IPC -> 팝업 표시 -> 설정 카드 지목까지 한 번에 지난다.
   */
  async function clickTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    console.log("[clicktest] 누르기 전 팝업 보임:", popup.isVisible());
    const found = await widget.webContents.executeJavaScript(
      `(() => { const g = document.querySelector('.gear'); if (!g) return false; g.click(); return true; })()`);
    console.log("[clicktest] 버튼 찾음:", found);
    await settle(900);
    console.log("[clicktest] 누른 뒤 팝업 보임:", popup.isVisible());
    // 지목 표시는 900ms짜리 애니메이션이라, 끝나기 전에 본다.
    console.log("[clicktest] 설정 카드 지목:", await popup.webContents.executeJavaScript(
      `!!document.querySelector('.card.settings.pointed')`), "(기대 true)");

    // 설정 버튼은 토글이다. 열린 상태에서 다시 누르면 닫혀야 한다.
    await widget.webContents.executeJavaScript(`document.querySelector('.gear').click()`);
    await settle(600);
    console.log("[clicktest] 다시 누름 -> 팝업:", popup.isVisible(), "(기대 false)");

    // 닫힌 뒤 또 누르면 다시 열려야 한다. 재열기 방지 시간이 지난 뒤에 눌러 본다.
    await settle(500);
    await widget.webContents.executeJavaScript(`document.querySelector('.gear').click()`);
    await settle(600);
    console.log("[clicktest] 한 번 더   -> 팝업:", popup.isVisible(), "(기대 true)");
    popup.hide();
    await settle(600);

    // 띠를 그냥 누르고 뗀 경우: 팝업이 열려야 한다.
    const start = widget.getBounds();
    setHold({ hover: true, press: true });
    await widget.webContents.executeJavaScript(`window.usage.mouseUp()`);
    setHold({ hover: false, press: false });
    await settle(600);
    console.log("[clicktest] 제자리 클릭 -> 팝업:", popup.isVisible(), "(기대 true)");
    popup.hide();
    await settle(400);

    // 끌고 나서 뗀 경우: 팝업이 열리면 안 되고, 옮긴 자리가 저장돼야 한다.
    setHold({ hover: true, press: true });
    widget.setPosition(start.x + 24, start.y);
    await widget.webContents.executeJavaScript(`window.usage.mouseUp()`);
    setHold({ hover: false, press: false });
    await settle(600);
    console.log("[clicktest] 끌고 뗌     -> 팝업:", popup.isVisible(), "(기대 false)");
    // DPI 배율 때문에 1px 어긋날 수 있다. 자리를 옮겨 저장됐는지만 본다.
    console.log("[clicktest] 저장된 좌표:", `${config.x},${config.y}`,
      `| 옮긴 자리에 저장됐나: ${Math.abs(config.x - (start.x + 24)) <= 2}`);

    widget.setPosition(start.x, start.y);
    enforceBounds();
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    app.exit(0);
  }

  /**
   * 값이 바뀔 때의 동작을 눈 없이 확인한다.
   * 구르는 중인지, 끝난 뒤 옛 숫자가 남지 않는지, 막대가 따라왔는지를 본다.
   */
  async function motionTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const probe = (js) => widget.webContents.executeJavaScript(js);
    const SEL = `.cell[data-provider="claude"]`;

    console.log("[motiontest] 처음 숫자:", await probe(`document.querySelector('${SEL} .num').textContent`));

    const fake = structuredClone(report);
    const claude = fake.providers.find((p) => p.provider === "claude");
    if (!claude?.weekly) { console.log("[motiontest] Claude 주간 값이 없어 건너뜀"); app.exit(0); }
    claude.weekly.leftPercent = 42;
    widget.webContents.send("state", { report: fake, config: publicConfig() });

    await settle(150);
    console.log("[motiontest] 구르는 중:", await probe(`!!document.querySelector('${SEL} .roll.rolling')`));
    console.log("[motiontest] 올라오는 숫자:", await probe(
      `document.querySelector('${SEL} .num.incoming')?.textContent ?? '없음'`));

    // 구르는 도중에 새 값이 오면 그쪽이 이겨야 한다. 글자로 비교하면 이 갱신이
    // 버려지고 롤이 끝날 때 옛 값이 다시 쓰였다. 그 회귀를 여기서 잡는다.
    claude.weekly.leftPercent = 17;
    widget.webContents.send("state", { report: fake, config: publicConfig() });

    await settle(900);
    console.log("[motiontest] 롤 중 갱신 후 숫자:", await probe(`document.querySelector('${SEL} .num').textContent`), "(기대 17)");
    console.log("[motiontest] 남은 incoming 개수:", await probe(`document.querySelectorAll('.num.incoming').length`), "(기대 0)");
    console.log("[motiontest] 주간 막대 높이:", await probe(
      `document.querySelector('${SEL} .track:last-child .fill').style.height`), "(기대 17%)");

    app.exit(0);
  }

  /**
   * 평소 실행과 같은 조건(작업표시줄 감시 켜짐)에서 실제로 그려진 상태를 읽는다.
   * 캡처용 플래그는 감시를 끄고 돌기 때문에 이 상황을 재현하지 못한다.
   */
  async function liveCheckAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    // 평소 실행과 똑같이 whenReady에서 이미 감시가 켜져 있다. 여기서 또 켜지 않는다.
    await settle(2000);

    console.log("[livecheck] 작업표시줄 보임:", taskbarShown);
    console.log("[livecheck] 창 보임:", widget.isVisible(), "| 창 투명도:", widget.getOpacity(),
      "(1이어야 정상 — transparent 창에 창 투명도를 걸면 알파가 깨진다)");

    // 긴 값을 넣어 한계를 시험한다. 지금 값만 보면 아슬아슬한지 알 수 없다.
    console.log("[livecheck] 긴 글자 시험:", await widget.webContents.executeJavaScript(`
      (() => {
        const rows = [];
        for (const c of document.querySelectorAll('.cell')) {
          const plan = c.querySelector('.plan'), until = c.querySelector('.until');
          const keep = [plan.textContent, until.textContent];
          plan.textContent = 'ChatGPT Enterprise';
          until.textContent = '13일 23시간';
          rows.push({ provider: c.dataset.provider,
            planCut: plan.scrollWidth > plan.clientWidth + 1,
            untilCut: until.scrollWidth > until.clientWidth + 1,
            untilNeed: until.scrollWidth, untilHas: until.clientWidth });
          plan.textContent = keep[0]; until.textContent = keep[1];
        }
        return JSON.stringify(rows, null, 1);
      })()`));

    console.log("[livecheck] 글자 잘림 검사:", await widget.webContents.executeJavaScript(`
      JSON.stringify([...document.querySelectorAll('.cell')].map(c => ({
        provider: c.dataset.provider,
        state: c.className.replace('cell','').trim() || 'ready',
        cellOpacity: getComputedStyle(c.querySelector('.meta')).opacity,
        plan: c.querySelector('.plan')?.textContent,
        planCut: (c.querySelector('.plan')?.scrollWidth ?? 0) > (c.querySelector('.plan')?.clientWidth ?? 0) + 1,
        until: c.querySelector('.until')?.textContent,
        untilCut: (c.querySelector('.until')?.scrollWidth ?? 0) > (c.querySelector('.until')?.clientWidth ?? 0) + 1,
        metaW: c.querySelector('.meta')?.clientWidth,
        needW: Math.max(c.querySelector('.plan')?.scrollWidth ?? 0,
          (c.querySelector('.win')?.scrollWidth ?? 0) + 4 + (c.querySelector('.until')?.scrollWidth ?? 0)),
      })), null, 1)`));
    // 트레이 아이콘이 비면 작업표시줄에 빈 칸만 남는다. 예외가 안 나므로 직접 본다.
    const icon = trayIcon();
    console.log("[livecheck] 트레이 아이콘 비어있나:", icon.isEmpty(),
      "| 크기:", JSON.stringify(icon.getSize()));
    console.log("[livecheck] 창 bounds:", JSON.stringify(widget.getBounds()));
    console.log("[livecheck] 렌더러:", await widget.webContents.executeJavaScript(`
      (() => {
        const p = document.getElementById('plate');
        const cs = getComputedStyle(p);
        const cell = document.querySelector('.cell');
        return JSON.stringify({
          plateClass: p.className,
          plateOpacity: cs.opacity,
          plateTransform: cs.transform,
          plateSize: [p.offsetWidth, p.offsetHeight],
          cellCount: document.querySelectorAll('.cell').length,
          firstNum: document.querySelector('.num')?.textContent ?? '없음',
          cellOpacity: cell ? getComputedStyle(cell).opacity : '셀없음',
          bodySize: [document.body.offsetWidth, document.body.offsetHeight],
        });
      })()`));

    // 사용자가 보는 그대로를 찍는다. 작업표시줄이 숨어 있으면 창도 숨어 있으므로
    // 따라가기만 잠시 끄고 띄운 뒤 찍는다.
    const shotDir = process.argv[process.argv.indexOf("--livecheck") + 1];
    if (shotDir && !shotDir.startsWith("--")) {
      const before = config.followTaskbar;
      config.followTaskbar = false;
      syncWidgetVisibility();
      await settle(900);
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, "live-widget.png"),
        (await widget.webContents.capturePage()).toPNG());
      showPopup();
      await settle(900);
      fs.writeFileSync(path.join(shotDir, "live-popup.png"),
        (await popup.webContents.capturePage()).toPNG());
      console.log("[livecheck] 캡처 완료:", shotDir);
      config.followTaskbar = before;
    }

    stopTaskbarWatcher();
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    app.exit(0);
  }

  /**
   * 붙잡기를 확인한다.
   *
   * 작업표시줄이 내려가는 순간에도 (1) 마우스를 올려 두었거나 (2) 끌고 있거나
   * (3) 설정창이 열려 있으면 위젯이 남아 있어야 한다. 마우스 없이, 실제로 쓰는
   * 경로(setHold / moved / popup)를 그대로 거쳐 확인한다.
   */
  async function holdTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const vis = () => widget.isVisible();
    const hideTaskbar = () => applyTaskbarState(false);
    const showTaskbar = () => applyTaskbarState(true);

    config.followTaskbar = true;

    console.log("--- 기준: 붙잡기 없음 ---");
    showTaskbar(); await settle(400);
    console.log("[holdtest] 작업표시줄 올라옴 -> 위젯:", vis(), "(기대 true)");
    hideTaskbar(); await settle(1000);
    console.log("[holdtest] 작업표시줄 내려감 -> 위젯:", vis(), "(기대 false)");

    // 마우스를 움직이지 않고 호버를 만든다: 위젯을 커서 아래로 옮긴다.
    // 사용자의 포인터를 건드리지 않으면서 실제 cursorOver 경로를 그대로 탄다.
    console.log("--- 1. 마우스를 올려 둔 동안 ---");
    showTaskbar(); await settle(400);
    const home = widget.getBounds();
    const cur = screen.getCursorScreenPoint();
    widget.setPosition(Math.round(cur.x - home.width / 2), Math.round(cur.y - home.height / 2));
    await settle(400);
    console.log("[holdtest] 커서가 위젯 위인가:", cursorOver, "(기대 true)");
    await settle(1400);                       // 방금의 '움직임' 붙잡기를 흘려보낸다
    hideTaskbar(); await settle(900);
    console.log("[holdtest] 호버 중 내려감 -> 위젯:", vis(), "(기대 true)");

    widget.setPosition(home.x, home.y);       // 커서에서 치운다
    // 붙잡기 해제(1.2초) + 재검사 주기(0.4초) + 페이드(0.32초)를 모두 넘겨 기다린다.
    await settle(2600);
    console.log("[holdtest] 마우스 치운 뒤 -> 위젯:", vis(), "(기대 false)");

    // DOM 이벤트(setHold) 없이, 창이 움직이는 것만으로 붙잡혀야 한다.
    // 실제 드래그는 OS가 가져가서 렌더러에 마우스 이벤트가 오지 않기 때문이다.
    console.log("--- 2. 끌고 있는 동안 (DOM 이벤트 없이) ---");
    showTaskbar(); await settle(400);
    const b = widget.getBounds();
    widget.setPosition(b.x + 24, b.y);       // 끄는 중
    await settle(250);                        // 폴링(120ms)이 한 번은 돌도록
    hideTaskbar(); await settle(600);
    console.log("[holdtest] 끄는 중 내려감 -> 위젯:", vis(), "(기대 true)");
    await settle(2600);                       // 붙잡기 해제 + 재검사 + 페이드를 모두 넘긴다
    console.log("[holdtest] 손 뗀 뒤       -> 위젯:", vis(), "(기대 false)");
    widget.setPosition(b.x, b.y);

    console.log("--- 3. 설정창이 열려 있는 동안 ---");
    showTaskbar(); await settle(400);
    showPopup(); await settle(400);
    hideTaskbar(); await settle(900);
    console.log("[holdtest] 설정창 열림 -> 위젯:", vis(), "(기대 true)");
    popup.hide(); await settle(1400);
    console.log("[holdtest] 설정창 닫힘 -> 위젯:", vis(), "(기대 false)");

    stopTaskbarWatcher();
    stopStayTop();
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    app.exit(0);
  }

  /**
   * 배율을 확인한다. UI가 쓰는 setScale()을 그대로 거치므로 실제 동작과 같다.
   * 폴더를 주면 각 배율의 모습도 찍는다.
   */
  async function scaleTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const dir = process.argv[process.argv.indexOf("--scaletest") + 1];
    const shoot = dir && !dir.startsWith("--");
    if (shoot) fs.mkdirSync(dir, { recursive: true });

    const before = config.scale;
    const base = widgetSize({ ...config, scale: 1 });
    console.log("[scaletest] 배율 1 기준 크기:", JSON.stringify(base));

    for (const scale of SCALES) {
      setScale(scale);
      await settle(800);
      const b = widgetSize(config);
      const actual = widget.getBounds();
      const zoom = widget.webContents.getZoomFactor();
      console.log(`[scaletest] ${scale}: 기대 ${b.width}x${b.height}`
        + ` | 실제 ${actual.width}x${actual.height} | 확대율 ${zoom.toFixed(2)}`);
      if (shoot) {
        fs.writeFileSync(path.join(dir, `scale-${scale}.png`),
          (await widget.webContents.capturePage()).toPNG());
      }
    }

    setScale(before);
    await settle(400);
    stopTaskbarWatcher();
    stopStayTop();
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    console.log("[scaletest] 배율 원복:", config.scale);
    app.exit(0);
  }

  /**
   * 위젯이 작업표시줄보다 위에 있는지 z순서로 확인한다.
   *
   * 자동 숨김 작업표시줄은 숨어 있어도 창 자체는 살아 있으므로, 올라오기를
   * 기다리지 않고도 두 창의 z순서를 비교할 수 있다.
   */
  async function zOrderTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));

    // 설정은 건드리지 않고 메모리에서만 잠시 끈다. 창이 떠 있어야 잴 수 있다.
    const before = config.followTaskbar;
    config.followTaskbar = false;
    syncWidgetVisibility();
    await settle(1200);
    console.log("[ztest] 위젯 보임:", widget.isVisible());

    const script = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class Z {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
'@
$rows = New-Object System.Collections.ArrayList
$cb = [Z+EnumProc]{ param($h,$l)
  if ([Z]::IsWindowVisible($h)) {
    $t = New-Object Text.StringBuilder 256; [void][Z]::GetWindowText($h,$t,256)
    $c = New-Object Text.StringBuilder 256; [void][Z]::GetClassName($h,$c,256)
    [void]$rows.Add(($t.ToString() + '|' + $c.ToString()))
  }
  return $true
}
[void][Z]::EnumWindows($cb,[IntPtr]::Zero)
$i=0; foreach ($r in $rows) { ($i.ToString() + '>' + $r); $i++ }`;

    const { execFile } = await import("node:child_process");
    const out = await new Promise((resolve) => {
      execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
        (_e, stdout) => resolve(stdout || ""));
    });

    const lines = out.split(/\r?\n/).filter(Boolean);
    const trayLine = lines.find((l) => l.includes("|Shell_TrayWnd"));
    const widgetLine = lines.find((l) => l.includes(">AI Usage|"));
    const idx = (l) => (l ? Number(l.split(">")[0]) : -1);

    console.log("[ztest] 전체 보이는 창:", lines.length, "개 (작은 번호일수록 위)");
    console.log("[ztest] 위젯        :", widgetLine ?? "못 찾음");
    console.log("[ztest] 작업표시줄  :", trayLine ?? "못 찾음");
    if (widgetLine && trayLine) {
      console.log("[ztest] 위젯이 작업표시줄보다 위인가:", idx(widgetLine) < idx(trayLine));
    }

    config.followTaskbar = before;
    stopTaskbarWatcher();
    stopStayTop();
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    app.exit(0);
  }

  /**
   * 작업표시줄 따라가기를 확인한다.
   * 지금 작업표시줄이 자동 숨김 상태인지에 따라 기대값이 달라지므로 둘 다 적는다.
   */
  async function taskbarTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const before = config.followTaskbar;

    const origin = widget.getBounds();
    console.log("[tbtest] 처음 위치:", `${origin.x},${origin.y}`);

    startTaskbarWatcher();
    await settle(1500);
    console.log("[tbtest] 작업표시줄 보임:", taskbarShown);
    console.log("[tbtest] 따라가기 켠 상태의 위젯 보임:", widget.isVisible(),
      `(기대 ${taskbarShown})`);

    setFollowTaskbar(false);
    await settle(600);
    const back = widget.getBounds();
    console.log("[tbtest] 따라가기 끈 뒤 위젯 보임:", widget.isVisible(), "(기대 true)");
    console.log("[tbtest] 숨겼다 띄운 뒤 위치:", `${back.x},${back.y}`,
      `(기대 ${origin.x},${origin.y})`);
    console.log("[tbtest] 저장된 좌표:", `${config.x},${config.y}`);

    setFollowTaskbar(true);
    await settle(600);
    console.log("[tbtest] 다시 켠 뒤 위젯 보임:", widget.isVisible(), `(기대 ${taskbarShown})`);

    stopTaskbarWatcher();
    if (saveTimer) clearTimeout(saveTimer);
    config.followTaskbar = before;   // 개발용 플래그가 설정을 바꾸지 않게 되돌린다
    writeConfig(config);
    app.exit(0);
  }

  /** 드래그 저장·화면 밖 복귀 경로를 눈 없이 확인한다. */
  async function moveTestAndExit() {
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    const area = screen.getPrimaryDisplay().workArea;
    console.log("[movetest] 디스플레이:", JSON.stringify(
      screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scale: d.scaleFactor }))));
    console.log("[movetest] 기대 크기:", JSON.stringify(widgetSize(config)));
    console.log("[movetest] 생성 직후 bounds:", JSON.stringify(widget.getBounds()),
      "contentSize:", JSON.stringify(widget.getContentSize()));

    widget.setPosition(area.x + 120, area.y + 90);     // 평범한 이동
    await settle(600);
    console.log("[movetest] 이동 후 bounds:", JSON.stringify(widget.getBounds()));
    console.log("[movetest] 저장된 좌표:", config.x, config.y);

    widget.setPosition(area.x + area.width + 500, area.y + 90);  // 화면 밖으로
    await settle(600);
    const after = widget.getBounds();
    console.log("[movetest] 화면 밖 시도 후 bounds:", JSON.stringify(after));
    console.log("[movetest] 작업영역 오른쪽 끝:", area.x + area.width);
    console.log("[movetest] 화면 안으로 되돌아왔나:",
      after.x + after.width <= area.x + area.width);

    writeConfig(config);
    app.exit(0);
  }

  app.on("before-quit", () => {
    stopTaskbarWatcher();
    stopStayTop();
    stopInteractionPoll();
    if (noticeTimer) clearTimeout(noticeTimer);
    if (fadeTimer) clearTimeout(fadeTimer);
    if (saveTimer) clearTimeout(saveTimer);
    writeConfig(config);
    saveCache(cache);
    saveForecastState(forecastState);
  });
}
