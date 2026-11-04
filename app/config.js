import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { screen } from "electron";
import { parseJsonLoose } from "../src/store.js";

/**
 * 기본 크기.
 *
 * 제공자마다 5H·WK 두 줄을 보여주므로, 한 줄에 태그·막대·%·리셋이 모두 들어갈
 * 가로 폭이 필요하다. 좁히려면 배율(SCALES)을 낮춘다.
 */
export const WIDGET_BASE = { width: 500, height: 46 };

/**
 * 위젯 배율. 창 크기와 페이지 확대율에 같이 곱한다.
 * px 값을 하나하나 줄이지 않고 통째로 축소하므로 글자와 막대 비율이 그대로 남는다.
 */
export const SCALES = [0.7, 0.85, 1, 1.15];

/**
 * 직접 지정할 수 있는 Claude 플랜.
 *
 * 플랜 이름은 토큰에 박혀 오는데, 그 값은 토큰 발급 시점에 고정된다. 플랜을 바꾸거나
 * Anthropic이 이름을 바꾸면(2026-10: Max 5x -> Max, Max 20x -> Ultra) 한동안 옛 값이
 * 남는다. 실제로 Ultra 사용자에게 max_5x가 왔다. 그래서 직접 고를 수 있게 둔다.
 */
export const CLAUDE_PLANS = ["auto", "Pro", "Max", "Ultra"];

const DEFAULTS = {
  x: null,            // null이면 첫 실행. 주 화면 오른쪽 아래에 둔다.
  y: null,
  scale: 1,
  intervalSec: 60,
  openAtLogin: true,
  locked: false,          // 잠그면 드래그로 움직이지 않는다
  followTaskbar: true,    // 작업표시줄이 숨으면 위젯도 숨는다
  notify: true,           // 한도 임박·소진 예상 시 OS 알림
  // Claude 플랜 직접 지정. 토큰에 박힌 티어 값이 옛 이름이거나 오래됐을 때 쓴다.
  claudePlan: "auto",     // auto | Pro | Max | Ultra
  opacity: 0.94,
};

export function configPath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "ai-usage-collector", "widget.json");
}

/**
 * 설정 파일이 **있는데 못 읽은** 상태. 그러면 기본값으로 돌아가지만, 그 기본값을
 * 다시 적어 사용자의 설정을 덮어쓰지는 않는다.
 *
 * 부팅 직후 한 번 이런 일이 있었다. 저장된 배율·플랜 대신 기본값으로 떴다.
 * 그 상태에서 창을 한 번만 옮겨도 저장이 일어나 설정이 통째로 날아간다.
 */
let readFailed = false;

/** 설정을 못 읽어 기본값으로 돌아갔는가. 진단용. */
export function configReadFailed() {
  return readFailed;
}

export function readConfig(file = configPath()) {
  let saved = {};
  readFailed = false;

  // 부팅 직후에는 파일이 잠깐 안 읽힐 수 있다. 몇 번 더 해 본다.
  for (let tries = 0; tries < 3; tries++) {
    try {
      saved = parseJsonLoose(fs.readFileSync(file, "utf8"));
      break;
    } catch (err) {
      if (err?.code === "ENOENT") break;        // 첫 실행. 기본값이 맞다
      // 내용이 깨진 것은 다시 읽어도 같다. 기본값으로 덮어써 되살리는 편이 낫다.
      if (!err?.code) break;
      if (tries === 2) { readFailed = true; break; }
      sleepSync(150);
    }
  }

  const config = { ...DEFAULTS, ...saved };
  // 모르는 값이 들어와도 UI가 깨지지 않게 막는다.
  if (!SCALES.includes(config.scale)) config.scale = DEFAULTS.scale;
  if (!CLAUDE_PLANS.includes(config.claudePlan)) config.claudePlan = DEFAULTS.claudePlan;
  return config;
}

/** 읽기 재시도 사이의 짧은 기다림. 설정을 읽는 시점에는 아직 창이 없다. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeConfig(config, file = configPath()) {
  // 못 읽은 설정 위에 기본값을 덮지 않는다. 잃는 쪽이 훨씬 나쁘다.
  if (readFailed) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function widgetSize(config) {
  const scale = SCALES.includes(config.scale) ? config.scale : 1;
  return {
    width: Math.round(WIDGET_BASE.width * scale),
    height: Math.round(WIDGET_BASE.height * scale),
  };
}

/**
 * 저장된 좌표를 화면 안으로 되돌린다.
 *
 * 모니터를 뽑았거나 해상도가 바뀌면 저장된 좌표가 화면 밖일 수 있다. 그때는
 * 위젯이 안 보이고 사용자는 이유를 모른다. 그래서 복원할 때마다 실제 디스플레이
 * 작업 영역에 맞춰 집어넣는다.
 *
 * @returns {{x: number, y: number, clamped: boolean}}
 */
export function restorePosition(config, size = widgetSize(config)) {
  if (config.x === null || config.y === null) {
    return { ...defaultPosition(size), clamped: false };
  }
  const fixed = clampToDisplay({ x: config.x, y: config.y, ...size }, size);
  return { ...fixed, clamped: fixed.x !== config.x || fixed.y !== config.y };
}

/** 첫 실행 위치: 주 화면 작업 영역의 오른쪽 아래. 작업표시줄을 가리지 않는다. */
export function defaultPosition(size) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - size.width - 16,
    y: workArea.y + workArea.height - size.height - 12,
  };
}

/**
 * 드래그나 크기 변경으로 화면 밖으로 나가지 않게 막는다 (오류 예방).
 *
 * 작업 영역(workArea)이 아니라 **모니터 전체(bounds)**를 기준으로 한다.
 * 이 위젯은 작업표시줄 위에 겹쳐 뜨는 오버레이이고, 사용자가 일부러 맨 아래에
 * 둔다. 작업 영역으로 자르면 작업표시줄이 자리를 차지할 때마다 위로 밀려나
 * "가만히 뒀는데 위젯이 움직였다"가 된다. 실제로 1096 -> 1034로 밀렸다.
 */
export function clampToDisplay(bounds, size) {
  const area = screen.getDisplayMatching({
    x: Math.round(bounds.x), y: Math.round(bounds.y),
    width: size.width, height: size.height,
  }).bounds;
  return {
    x: clamp(bounds.x, area.x, area.x + area.width - size.width),
    y: clamp(bounds.y, area.y, area.y + area.height - size.height),
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(n, max));
}
