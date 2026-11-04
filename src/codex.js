import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { normalizeWindow, clampPercent } from "./window.js";
import { staleOr } from "./claude.js";

/* ------------------------------------------------------------------ *
 * 1. 실행 파일 찾기
 * ------------------------------------------------------------------ */

/**
 * codex.exe 후보를 모아 가장 최근에 갱신된 것을 고른다.
 * npm 전역 설치본(codex.cmd)은 쓰지 않는다. Windows에서 .cmd 를 spawn 하면
 * Node가 EINVAL로 거부하거나 shell을 거쳐야 하므로, 네이티브 .exe만 쓴다.
 */
export function findCodexExecutable(env = process.env) {
  if (env.CODEX_EXECUTABLE && fs.existsSync(env.CODEX_EXECUTABLE)) return env.CODEX_EXECUTABLE;

  const home = os.homedir();
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [];

  // Codex 데스크톱/CLI 본체: %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  pushChildren(candidates, binRoot, (dir) => path.join(dir, "codex.exe"));

  // npm 패키지에 들어 있는 네이티브 바이너리
  for (const root of [
    path.join(localAppData, "..", "Roaming", "npm", "node_modules", "@openai", "codex"),
    path.join(home, "AppData", "Roaming", "npm", "node_modules", "@openai", "codex"),
  ]) {
    candidates.push(path.join(root, "node_modules", "@openai", "codex-win32-x64", "codex.exe"));
  }

  // VSCode / Windsurf 확장에 번들된 것
  for (const extRoot of [path.join(home, ".vscode", "extensions"), path.join(home, ".windsurf", "extensions")]) {
    pushChildren(candidates, extRoot, (dir) =>
      path.basename(dir).startsWith("openai.chatgpt-")
        ? path.join(dir, "bin", "windows-x86_64", "codex.exe")
        : null);
  }

  return newestExisting(candidates);
}

function pushChildren(out, root, toExe) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const exe = toExe(path.join(root, e.name));
    if (exe) out.push(exe);
  }
}

function newestExisting(paths) {
  let best = null;
  let bestTime = -1;
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      continue;
    }
    if (stat.mtimeMs > bestTime) {
      bestTime = stat.mtimeMs;
      best = p;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 2. app-server JSON-RPC
 * ------------------------------------------------------------------ */

/**
 * `codex app-server` 를 자식 프로세스로 띄우고 줄 단위 JSON-RPC로 말한다.
 * 한 번의 수집에 한 번만 띄우고 바로 닫는다. 상주시키지 않는 이유는
 * 위젯이 몇 분에 한 번 조회하는 용도라 프로세스를 살려 둘 이득이 없고,
 * 죽은 파이프 복구 로직을 들고 다닐 필요가 없기 때문이다.
 */
export class CodexAppServer {
  constructor(exePath) {
    this.exePath = exePath;
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async open({ timeoutMs = 8000 } = {}) {
    this.child = spawn(this.exePath, ["app-server"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    if (!this.child.stdin || !this.child.stdout) {
      this.close();
      throw new Error("codex app-server stdio 파이프 열기 실패");
    }
    this.child.on("error", (e) => this.rejectAll(e));
    this.child.on("exit", () => this.rejectAll(new Error("codex app-server가 종료됨")));
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "ai_usage_collector", title: "AI Usage Collector", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    }, timeoutMs);
    this.notify("initialized", {});
  }

  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 로그 줄 등은 무시
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new Error(msg.error.message || "codex app-server error"));
    else waiter.resolve(msg.result);
  }

  request(method, params, timeoutMs = 4000) {
    if (!this.child || this.child.killed) return Promise.reject(new Error("codex app-server가 실행 중이 아님"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server '${method}' 응답 없음 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  rejectAll(err) {
    for (const [, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.pending.clear();
  }

  close() {
    this.rejectAll(new Error("닫힘"));
    this.rl?.close();
    this.rl = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
  }
}

/* ------------------------------------------------------------------ *
 * 3. 플랜 이름 + 레이트리밋 정규화
 * ------------------------------------------------------------------ */

const PLAN_NAMES = {
  free: "ChatGPT Free",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  ent26: "ChatGPT Enterprise",
};

export function formatCodexPlan(planType) {
  if (typeof planType !== "string" || !planType) return null;
  const key = planType.toLowerCase();
  return PLAN_NAMES[key] ?? `ChatGPT ${planType.charAt(0).toUpperCase() + planType.slice(1)}`;
}

/**
 * app-server의 레이트리밋은 Anthropic과 모양이 다르다.
 * usedPercent(0~100)와 resetsAt(유닉스 초)을 쓴다. 공통 모양으로 바꿔 둔다.
 */
export function normalizeCodexWindow(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const used = Number(raw.usedPercent);
  if (!Number.isFinite(used)) return null;
  const resetsAtSec = Number(raw.resetsAt);
  const resetsAt = resetsAtSec > 0 ? new Date(resetsAtSec * 1000).toISOString() : null;
  // normalizeWindow가 utilization/resets_at 이름을 쓰므로 그 모양으로 넘긴다.
  return normalizeWindow({ utilization: clampPercent(used), resets_at: resetsAt }, now);
}

/**
 * primary / secondary 중 어느 쪽이 세션(5시간)이고 어느 쪽이 주간인지는
 * windowDurationMins로 판단한다. Pro처럼 주간 한도만 있는 플랜도 있다.
 */
export function splitCodexWindows(rateLimits, planType, now = Date.now()) {
  const primary = rateLimits?.primary ?? null;
  const secondary = rateLimits?.secondary ?? null;
  const primaryMins = Number(primary?.windowDurationMins) || 0;
  const isPro = String(planType).toLowerCase() === "pro"
    || String(rateLimits?.planType).toLowerCase() === "pro";
  const weeklyOnly = isPro || (!primary && !!secondary) || primaryMins >= 1440;

  if (weeklyOnly) {
    const w = (primaryMins >= 1440 ? primary : secondary || primary) || null;
    return { session: null, weekly: normalizeCodexWindow(w, now), weeklyOnly: true };
  }
  return {
    session: normalizeCodexWindow(primary, now),
    weekly: normalizeCodexWindow(secondary, now),
    weeklyOnly: false,
  };
}

/* ------------------------------------------------------------------ *
 * 4. 수집
 * ------------------------------------------------------------------ */

/** auth.json의 id_token JWT에서 플랜과 이메일만 꺼낸다. 사용량은 여기서 못 얻는다. */
export async function readCodexIdentity(env = process.env) {
  const files = [
    path.join(env.APPDATA || "", "orca", "codex-runtime-home", "home", "auth.json"),
    path.join(os.homedir(), ".codex", "auth.json"),
  ].filter((p) => p && fs.existsSync(p));

  for (const file of files) {
    try {
      const auth = JSON.parse(await fsp.readFile(file, "utf8"));
      const jwt = auth?.tokens?.id_token || auth?.tokens?.access_token;
      if (!jwt) continue;
      const parts = jwt.split(".");
      if (parts.length < 2) continue;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      return {
        email: claims.email || claims["https://api.openai.com/profile"]?.email || null,
        planType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type || null,
        source: file,
      };
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/**
 * Codex 사용량. app-server RPC가 유일한 정확한 소스다.
 * 실패하면 플랜·이메일만 돌려주고 사용량은 null로 둔다. 추정치를 만들지 않는다.
 * @param {import("./cache.js").QuotaCache} cache
 */
export async function collectCodex(cache, { now = Date.now, exePath } = {}) {
  const KEY = "codex";
  const fresh = cache.getFresh(KEY);
  if (fresh) return { ...fresh, cache: "fresh" };

  const exe = exePath ?? findCodexExecutable();
  if (!exe) return withIdentity(await staleOrCodex(cache, KEY, "codex.exe를 찾을 수 없습니다"));

  const server = new CodexAppServer(exe);
  try {
    await server.open();
    const account = (await server.request("account/read", { refreshToken: false }))?.account;
    if (!account) throw new Error("Codex에 로그인되어 있지 않습니다");

    const res = await server.request("account/rateLimits/read", {});
    const rateLimits = res?.rateLimits
      ?? (res?.rateLimitsByLimitId && Object.values(res.rateLimitsByLimitId)[0]);
    if (!rateLimits) throw new Error("Codex 레이트리밋 정보가 비어 있습니다");

    const planType = account.planType || account.type || null;
    const { session, weekly, weeklyOnly } = splitCodexWindows(rateLimits, planType, now());

    const value = {
      provider: "codex",
      status: session || weekly ? "ready" : "error",
      error: session || weekly ? null : "레이트리밋 응답에 창 정보가 없음",
      plan: formatCodexPlan(planType),
      planRaw: { planType },
      email: account.email || null,
      tokenSource: "codex-app-server",
      weeklyOnly,
      session,
      weekly,
      models: {},
      pace: null,
      updatedAt: new Date(now()).toISOString(),
    };
    if (value.status === "ready") cache.put(KEY, value);
    return { ...value, cache: "live" };
  } catch (e) {
    return withIdentity(await staleOrCodex(cache, KEY, e.message));
  } finally {
    server.close();
  }
}

async function staleOrCodex(cache, key, reason) {
  return staleOr(cache, key, reason);
}

/** 사용량을 못 얻어도 플랜은 JWT에서 읽을 수 있다. 숫자는 비워 둔다. */
async function withIdentity(result) {
  if (result.status === "stale") return result;
  const id = await readCodexIdentity();
  if (!id) return result;
  return {
    ...result,
    plan: result.plan ?? formatCodexPlan(id.planType),
    planRaw: { planType: id.planType ?? null },
    email: id.email,
    tokenSource: "codex-auth.json",
  };
}
