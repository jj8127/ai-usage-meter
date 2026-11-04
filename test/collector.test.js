import { test } from "node:test";
import assert from "node:assert/strict";

import { QuotaCache, parseRetryAfter } from "../src/cache.js";
import { normalizeWindow, formatCountdown } from "../src/window.js";
import { formatPlan, normalizeUsage, pickCacheEntry, collectClaude, RateLimited } from "../src/claude.js";
import { splitCodexWindows, formatCodexPlan } from "../src/codex.js";

const T0 = Date.parse("2026-11-03T12:00:00Z");

/* ---------- 창 정규화: 위젯 버그를 재현해 막는다 ---------- */

test("five_hour가 null이어도 seven_day가 있으면 ready", () => {
  const raw = { five_hour: null, seven_day: { utilization: 16, resets_at: "2026-11-08T11:00:00Z" } };
  const out = normalizeUsage(raw, { rateLimitTier: "default_claude_max_5x" }, T0);
  assert.equal(out.status, "ready");
  assert.equal(out.session, null);
  assert.equal(out.weekly.leftPercent, 84);
});

test("두 창이 모두 없으면 error", () => {
  const out = normalizeUsage({ five_hour: null, seven_day: null }, {}, T0);
  assert.equal(out.status, "error");
  assert.match(out.error, /모두 없음/);
});

test("utilization이 숫자가 아니면 창을 버린다", () => {
  assert.equal(normalizeWindow({ utilization: "쉰", resets_at: null }, T0), null);
  assert.equal(normalizeWindow({ resets_at: "2026-11-08T11:00:00Z" }, T0), null);
});

test("utilization 100 초과는 100으로 묶고 exhausted", () => {
  const w = normalizeWindow({ utilization: 143, resets_at: null }, T0);
  assert.equal(w.usedPercent, 100);
  assert.equal(w.leftPercent, 0);
  assert.equal(w.exhausted, true);
  assert.equal(w.resetCountdown, "--");
});

test("리셋 시각이 지났으면 '곧 리셋'", () => {
  const w = normalizeWindow({ utilization: 10, resets_at: "2026-11-03T11:00:00Z" }, T0);
  assert.equal(w.resetInMs, 0);
  assert.equal(w.resetCountdown, "곧 리셋");
});

test("카운트다운 표기", () => {
  assert.equal(formatCountdown(null), "--");
  assert.equal(formatCountdown(25 * 60_000), "25min");
  assert.equal(formatCountdown(3 * 3600_000 + 12 * 60_000), "3h 12min");
  assert.equal(formatCountdown(4 * 86400_000 + 22 * 3600_000), "4d 22h");
});

/* ---------- 플랜 이름: rateLimitTier가 우선 ---------- */

test("rateLimitTier가 subscriptionType을 이긴다", () => {
  // 2026-10 말 이름 변경: Max 5x -> Max, Max 20x -> Ultra
  assert.equal(formatPlan({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" }), "Ultra");
  assert.equal(formatPlan({ rateLimitTier: "default_claude_max_5x", subscriptionType: "max" }), "Max");
  assert.equal(formatPlan({ rateLimitTier: "default_claude_ultra" }), "Ultra");
});

test("rateLimitTier가 없으면 subscriptionType으로", () => {
  assert.equal(formatPlan({ rateLimitTier: null, subscriptionType: "max" }), "Max");
  assert.equal(formatPlan({}), null);
});

test("모르는 티어는 버리지 않고 읽을 수 있게 바꾼다", () => {
  assert.equal(formatPlan({ rateLimitTier: "default_claude_max_50x" }), "Max 50x");  // 모르는 티어는 그대로
  assert.equal(formatPlan({ rateLimitTier: "something_new" }), "Something New");
});

test("Codex 플랜 이름", () => {
  assert.equal(formatCodexPlan("plus"), "ChatGPT Plus");
  assert.equal(formatCodexPlan("ent26"), "ChatGPT Enterprise");
  assert.equal(formatCodexPlan("newtier"), "ChatGPT Newtier");
  assert.equal(formatCodexPlan(null), null);
});

/* ---------- 토큰 캐시 엔트리 선택 ---------- */

const ACCT = "3618aaaa-bbbb";
const cacheFixture = {
  [`acct:${ACCT}|x:y:https://api.anthropic.com:user:profile`]: { token: "profile-only" },
  [`acct:${ACCT}|x:y:https://api.anthropic.com:user:inference user:profile:claude_code`]: { token: "code-scope" },
  "acct:other-uuid|x:y:https://api.anthropic.com:user:profile": { token: "other-account" },
};

test("활성 계정의 claude_code 스코프 엔트리를 고른다", () => {
  assert.equal(pickCacheEntry(cacheFixture, ACCT).token, "code-scope");
});

test("계정 UUID를 모르고 계정이 여러 개면 실패한다", () => {
  assert.throws(() => pickCacheEntry(cacheFixture, null), /계정 여러 개/);
});

test("계정이 하나뿐이면 UUID 없이도 고른다", () => {
  const one = { [`acct:${ACCT}|x:y:https://api.anthropic.com:user:profile`]: { token: "t" } };
  assert.equal(pickCacheEntry(one, null).token, "t");
});

test("토큰이 빈 엔트리는 거른다", () => {
  assert.throws(() => pickCacheEntry({ "acct:a|x": { token: "" } }, "a"), /유효한 엔트리 없음/);
});

/* ---------- Retry-After 파싱 ---------- */

test("Retry-After: 초 단위", () => {
  assert.equal(parseRetryAfter("30"), 30_000);
  assert.equal(parseRetryAfter("0"), 0);
});

test("Retry-After: 없거나 이상하면 기본값", () => {
  assert.equal(parseRetryAfter(null, 5000), 5000);
  assert.equal(parseRetryAfter("나중에", 5000), 5000);
});

test("Retry-After: 1시간으로 상한", () => {
  assert.equal(parseRetryAfter("99999"), 3_600_000);
});

/* ---------- 캐시 동작 ---------- */

test("TTL 안에서는 fresh, 넘기면 null이지만 stale은 남는다", () => {
  let clock = 1000;
  const cache = new QuotaCache({ ttlMs: 60_000, now: () => clock });
  cache.put("k", { v: 1 });
  assert.deepEqual(cache.getFresh("k"), { v: 1 });
  clock += 60_001;
  assert.equal(cache.getFresh("k"), null);
  assert.equal(cache.getStale("k").value.v, 1);
  assert.ok(cache.getStale("k").ageMs >= 60_000);
});

test("block은 Retry-After 동안만 유지된다", () => {
  let clock = 0;
  const cache = new QuotaCache({ now: () => clock });
  cache.block("k", "30");
  assert.equal(cache.isBlocked("k"), true);
  clock = 29_999;
  assert.equal(cache.isBlocked("k"), true);
  clock = 30_000;
  assert.equal(cache.isBlocked("k"), false);
});

test("성공하면 block이 풀린다", () => {
  const cache = new QuotaCache();
  cache.block("k", "60");
  cache.put("k", { v: 1 });
  assert.equal(cache.isBlocked("k"), false);
});

/* ---------- 429 경로: 마지막 실측값을 stale로 ---------- */

const READY_RAW = { five_hour: { utilization: 20, resets_at: "2026-11-03T15:00:00Z" }, seven_day: null };

function fakeFetch(behavior) {
  return async () => {
    if (behavior === "ok") {
      return { ok: true, status: 200, json: async () => READY_RAW, headers: new Map() };
    }
    return {
      ok: false,
      status: 429,
      body: null,
      headers: { get: (h) => (h === "retry-after" ? "120" : null) },
    };
  };
}

test("429를 맞으면 마지막 실측값을 stale로 돌려주고 재호출을 막는다", async () => {
  let clock = T0;
  const cache = new QuotaCache({ ttlMs: 60_000, now: () => clock });
  const resolvers = [["fake", async () => ({ token: "t", source: "fake", rateLimitTier: "default_claude_pro" })]];

  // 1회차: 정상 수집
  const first = await collectClaude(cache, { fetchImpl: fakeFetch("ok"), now: () => clock, resolvers });
  assert.equal(first.status, "ready");
  assert.equal(first.plan, "Pro");

  // TTL을 넘긴 뒤 429
  clock += 60_001;
  let calls = 0;
  const counting = async (...a) => { calls++; return fakeFetch("429")(...a); };
  const second = await collectClaude(cache, { fetchImpl: counting, now: () => clock, resolvers });
  assert.equal(second.status, "stale");
  assert.match(second.error, /429/);
  assert.equal(second.session.usedPercent, 20, "stale은 마지막 실측 수치를 그대로 유지한다");
  assert.equal(calls, 1);

  // 백오프 중에는 네트워크를 건드리지 않는다
  clock += 1000;
  const third = await collectClaude(cache, { fetchImpl: counting, now: () => clock, resolvers });
  assert.equal(third.status, "stale");
  assert.equal(calls, 1, "백오프 중 추가 호출이 없어야 한다");
});

test("실측값이 없는 상태에서 실패하면 숫자를 꾸며내지 않는다", async () => {
  const cache = new QuotaCache();
  const resolvers = [["none", async () => { throw new Error("토큰 없음"); }]];
  const out = await collectClaude(cache, { fetchImpl: fakeFetch("ok"), resolvers });
  assert.equal(out.status, "error");
  assert.equal(out.session, null);
  assert.equal(out.weekly, null);
  assert.equal(out.plan, null);
  assert.match(out.error, /토큰 없음/);
});

/* ---------- Codex 창 분리 ---------- */

test("Plus는 5시간 + 주간 둘 다", () => {
  const out = splitCodexWindows({
    primary: { usedPercent: 0, resetsAt: 1762200000, windowDurationMins: 300 },
    secondary: { usedPercent: 2, resetsAt: 1762400000, windowDurationMins: 10080 },
  }, "plus", T0);
  assert.equal(out.weeklyOnly, false);
  assert.equal(out.session.leftPercent, 100);
  assert.equal(out.weekly.leftPercent, 98);
});

test("Pro는 주간만", () => {
  const out = splitCodexWindows({
    primary: { usedPercent: 10, resetsAt: 1762400000, windowDurationMins: 10080 },
    secondary: null,
  }, "pro", T0);
  assert.equal(out.weeklyOnly, true);
  assert.equal(out.session, null);
  assert.equal(out.weekly.leftPercent, 90);
});

test("primary 창이 1440분 이상이면 주간으로 본다", () => {
  const out = splitCodexWindows({
    primary: { usedPercent: 30, resetsAt: 1762400000, windowDurationMins: 10080 },
  }, "plus", T0);
  assert.equal(out.weeklyOnly, true);
  assert.equal(out.weekly.leftPercent, 70);
});

test("primary가 없고 secondary만 있으면 주간만", () => {
  const out = splitCodexWindows({ secondary: { usedPercent: 5, resetsAt: 0 } }, "plus", T0);
  assert.equal(out.weeklyOnly, true);
  assert.equal(out.weekly.leftPercent, 95);
  assert.equal(out.weekly.resetCountdown, "--");
});
