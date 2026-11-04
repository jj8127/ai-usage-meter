import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDecipheriv } from "node:crypto";
import { unprotect } from "./dpapi.js";
import { normalizeWindow } from "./window.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

export class RateLimited extends Error {
  constructor(retryAfter) {
    super("Anthropic usage API 429");
    this.name = "RateLimited";
    this.retryAfter = retryAfter;
  }
}

/* ------------------------------------------------------------------ *
 * 1. 토큰 경로
 * ------------------------------------------------------------------ */

/** Claude 데스크톱 앱의 사용자 데이터 폴더 후보들. 신버전이 먼저 오게 둔다. */
export function desktopDataDirs(env = process.env) {
  const dirs = [];
  if (env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, "Claude-Data");
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && /^claude_/i.test(e.name)) dirs.push(path.join(root, e.name));
      }
    } catch { /* 폴더 없음 */ }
  }
  if (env.APPDATA) dirs.push(path.join(env.APPDATA, "Claude"));
  return [...new Set(dirs)];
}

/**
 * Chromium os_crypt 방식. Local State의 encrypted_key를 DPAPI로 풀어 AES 키를 얻는다.
 * @returns {Promise<Buffer>} 32바이트 키
 */
async function readOsCryptKey(dir) {
  const localState = JSON.parse(await fsp.readFile(path.join(dir, "Local State"), "utf8"));
  const b64 = localState?.os_crypt?.encrypted_key;
  if (typeof b64 !== "string") throw new Error("os_crypt.encrypted_key 없음");
  const wrapped = Buffer.from(b64, "base64");
  if (wrapped.subarray(0, 5).toString() !== "DPAPI") throw new Error("DPAPI 접두사 없음");
  return unprotect(wrapped.subarray(5), 32);
}

/** v10/v11 AES-256-GCM 봉투를 풀어 JSON으로 돌려준다. 키는 호출자가 지운다. */
export function decryptEnvelope(b64, key) {
  const blob = Buffer.from(b64, "base64");
  if (blob.length < 31 || !["v10", "v11"].includes(blob.subarray(0, 3).toString())) {
    throw new Error("지원하지 않는 암호화 형식");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(3, 15));
  decipher.setAuthTag(blob.subarray(-16));
  const head = decipher.update(blob.subarray(15, -16));
  let plain;
  try {
    plain = Buffer.concat([head, decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } finally {
    head.fill(0);
    plain?.fill(0);
  }
}

/**
 * 토큰 캐시에서 쓸 엔트리를 고른다.
 * 키 형식: acct:<accountUuid>|<...>:<...>:https://api.anthropic.com:<scopes>
 * 활성 계정 것 중 claude_code 스코프를 가진 엔트리를 우선한다.
 */
export function pickCacheEntry(cache, accountUuid) {
  if (!cache || typeof cache !== "object") throw new Error("토큰 캐시가 비어 있음");
  let keys = Object.keys(cache);

  if (accountUuid) {
    const mine = keys.filter((k) => k.includes(accountUuid));
    if (mine.length) keys = mine;
  } else {
    // 계정 UUID를 모르면, 캐시에 계정이 하나뿐일 때만 진행한다.
    const uuids = new Set(keys.map((k) => /^acct:([^|]+)\|/.exec(k)?.[1]).filter(Boolean));
    if (uuids.size > 1) throw new Error("활성 계정을 특정할 수 없음 (계정 여러 개)");
  }

  keys.sort((a, b) => Number(!a.includes("claude_code")) - Number(!b.includes("claude_code")));
  const entry = keys.map((k) => cache[k]).find((v) => v && typeof v.token === "string" && v.token);
  if (!entry) throw new Error("토큰 캐시에 유효한 엔트리 없음");
  return entry;
}

/** 1순위: Claude 데스크톱 앱. 이 PC에서 실제로 동작하는 경로다. */
async function fromDesktopApp() {
  const problems = [];
  for (const dir of desktopDataDirs()) {
    try {
      const cfgPath = path.join(dir, "config.json");
      if (!fs.existsSync(cfgPath) || !fs.existsSync(path.join(dir, "Local State"))) continue;
      const cfg = JSON.parse(await fsp.readFile(cfgPath, "utf8"));
      if (typeof cfg["oauth:tokenCacheV2"] !== "string") {
        problems.push(`${dir}: tokenCacheV2 없음`);
        continue;
      }

      const key = await readOsCryptKey(dir);
      let tokenCache;
      try {
        tokenCache = decryptEnvelope(cfg["oauth:tokenCacheV2"], key);
      } finally {
        key.fill(0);
      }

      const uuid = cfg.lastKnownAccountUuid || cfg.activeAccountId || null;
      const entry = pickCacheEntry(tokenCache, uuid);
      return {
        token: entry.token,
        subscriptionType: entry.subscriptionType ?? null,
        rateLimitTier: entry.rateLimitTier ?? null,
        expiresAt: entry.expiresAt ? new Date(Number(entry.expiresAt)).toISOString() : null,
        accountUuid: uuid,
        source: "claude-desktop",
      };
    } catch (e) {
      problems.push(`${dir}: ${e.message}`);
    }
  }
  throw new Error(problems.length ? problems.join(" / ") : "Claude 데스크톱 앱 데이터 없음");
}

/** 2순위: Claude Code CLI 평문 파일. Windows에서 CLI로 /login 했을 때만 채워진다. */
async function fromCliFile(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  if (!fs.existsSync(file)) throw new Error(`${file} 없음`);
  const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("claudeAiOauth.accessToken 없음 (CLI 로그인 기록 없음)");
  return {
    token: oauth.accessToken,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
    expiresAt: oauth.expiresAt ? new Date(Number(oauth.expiresAt)).toISOString() : null,
    accountUuid: null,
    source: "claude-cli",
  };
}

/** 3순위: 환경변수. CI나 수동 주입용. */
async function fromEnv(env = process.env) {
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) throw new Error("CLAUDE_CODE_OAUTH_TOKEN 없음");
  return {
    token: env.CLAUDE_CODE_OAUTH_TOKEN,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    accountUuid: null,
    source: "env",
  };
}

/**
 * 토큰을 순서대로 찾는다. 실패한 경로의 이유를 모아 두므로 진단이 쉽다.
 * @returns {Promise<{credential: object, attempts: {source: string, error: string}[]}>}
 */
export async function resolveToken({ resolvers } = {}) {
  const chain = resolvers ?? [
    ["claude-desktop", fromDesktopApp],
    ["claude-cli", fromCliFile],
    ["env", fromEnv],
  ];
  const attempts = [];
  for (const [name, fn] of chain) {
    try {
      return { credential: await fn(), attempts };
    } catch (e) {
      attempts.push({ source: name, error: e.message });
    }
  }
  const detail = attempts.map((a) => `${a.source}: ${a.error}`).join(" | ");
  throw new Error(`Claude 토큰을 찾지 못했습니다 — ${detail}`);
}

/* ------------------------------------------------------------------ *
 * 2. 플랜 이름
 * ------------------------------------------------------------------ */

/**
 * 플랜 이름.
 *
 * Anthropic이 2026-10 말에 이름을 바꿨다: Max 5x -> **Max**, Max 20x -> **Ultra**.
 * 기존 가입자는 자동 이관됐고 가격은 그대로다. 토큰에 박힌 티어 문자열은 아직
 * 옛 이름(`default_claude_max_5x`)으로 오므로, 여기서 새 이름으로 옮겨 준다.
 */
const KNOWN_TIERS = {
  max_5x: "Max",
  max: "Max",
  max_20x: "Ultra",
  ultra: "Ultra",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
};

/**
 * rateLimitTier가 subscriptionType보다 정확하다. Max 5x와 Max 20x를 구분해 주는 건
 * rateLimitTier뿐이다. 둘 다 없으면 null.
 */
export function formatPlan({ rateLimitTier, subscriptionType } = {}) {
  if (typeof rateLimitTier === "string" && rateLimitTier) {
    const core = rateLimitTier.replace(/^default_/, "").replace(/^claude_/, "");
    if (KNOWN_TIERS[core]) return KNOWN_TIERS[core];
    // 모르는 티어는 버리지 않고 읽을 수 있게만 바꾼다.
    return core.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (typeof subscriptionType === "string" && subscriptionType) {
    return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 3. usage 호출 + 정규화
 * ------------------------------------------------------------------ */

export async function fetchUsageRaw(token, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const res = await fetchImpl(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": OAUTH_BETA,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (res.status === 429) {
    await res.body?.cancel().catch(() => {});
    throw new RateLimited(res.headers.get("retry-after"));
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`usage API HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * 응답을 위젯이 쓸 모양으로 줄인다.
 * 창은 각각 독립이다. five_hour가 null이어도 seven_day가 있으면 ready다.
 */
export function normalizeUsage(raw, credential, now = Date.now()) {
  const session = normalizeWindow(raw?.five_hour, now);
  const weekly = normalizeWindow(raw?.seven_day, now);

  return {
    provider: "claude",
    status: session || weekly ? "ready" : "error",
    error: session || weekly ? null : "usage 응답에 5시간·주간 창이 모두 없음",
    plan: formatPlan(credential),
    planRaw: {
      rateLimitTier: credential.rateLimitTier ?? null,
      subscriptionType: credential.subscriptionType ?? null,
    },
    tokenSource: credential.source,
    tokenExpiresAt: credential.expiresAt ?? null,
    session,
    weekly,
    models: {
      opus: normalizeWindow(raw?.seven_day_opus, now),
      sonnet: normalizeWindow(raw?.seven_day_sonnet, now),
    },
    // 토큰 낭비 방지용. 소비 속도 지표는 Anthropic이 주는 값을 그대로 전달한다.
    pace: raw?.pace ?? null,
    limits: raw?.limits ?? null,
    extraUsage: raw?.extra_usage ?? null,
    updatedAt: new Date(now).toISOString(),
  };
}

/** 마지막 성공값이 있으면 stale로, 없으면 error로. 숫자를 꾸며내지 않는다. */
export function staleOr(cache, key, reason) {
  const stale = cache.getStale(key);
  if (stale) {
    return { ...stale.value, status: "stale", error: reason, staleAgeMs: stale.ageMs, cache: "stale" };
  }
  return {
    provider: key,
    status: "error",
    error: reason,
    plan: null,
    session: null,
    weekly: null,
    models: {},
    pace: null,
    updatedAt: new Date().toISOString(),
    cache: "miss",
  };
}

/**
 * 캐시와 백오프를 거쳐 Claude 사용량을 돌려준다.
 * @param {import("./cache.js").QuotaCache} cache
 */
export async function collectClaude(cache, { fetchImpl = fetch, now = Date.now, resolvers } = {}) {
  const KEY = "claude";
  const fresh = cache.getFresh(KEY);
  if (fresh) return { ...fresh, cache: "fresh" };

  if (cache.isBlocked(KEY)) return staleOr(cache, KEY, "레이트리밋 대기 중 (429)");

  let credential;
  try {
    ({ credential } = await resolveToken({ resolvers }));
  } catch (e) {
    return staleOr(cache, KEY, e.message);
  }

  try {
    const raw = await fetchUsageRaw(credential.token, { fetchImpl });
    const value = normalizeUsage(raw, credential, now());
    if (value.status === "ready") cache.put(KEY, value);
    return { ...value, cache: "live" };
  } catch (e) {
    if (e instanceof RateLimited) {
      cache.block(KEY, e.retryAfter);
      return staleOr(cache, KEY, "레이트리밋 (429)");
    }
    return staleOr(cache, KEY, e.message);
  } finally {
    credential.token = "";
  }
}
