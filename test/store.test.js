import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { QuotaCache } from "../src/cache.js";
import { loadCache, saveCache, parseJsonLoose } from "../src/store.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-"));
  return path.join(dir, "last-usage.json");
}

test("디스크 왕복: 저장한 값이 다음 프로세스에서 되살아난다", () => {
  const file = tmpFile();
  const a = new QuotaCache({ ttlMs: 60_000 });
  a.put("claude", { provider: "claude", weekly: { leftPercent: 84 } });
  assert.equal(saveCache(a, file), true);

  const b = new QuotaCache({ ttlMs: 60_000 });
  assert.equal(loadCache(b, file), true);
  assert.equal(b.getFresh("claude").weekly.leftPercent, 84);
});

test("되살린 값도 TTL을 그대로 적용받는다", () => {
  const file = tmpFile();
  let clock = 1_000_000;
  const a = new QuotaCache({ ttlMs: 60_000, now: () => clock });
  a.put("claude", { v: 1 });
  saveCache(a, file);

  clock += 120_000;
  const b = new QuotaCache({ ttlMs: 60_000, now: () => clock });
  loadCache(b, file);
  assert.equal(b.getFresh("claude"), null, "2분 지난 값은 fresh가 아니다");
  assert.equal(b.getStale("claude").value.v, 1, "그래도 보여 줄 값은 있다");
});

test("파일이 없으면 조용히 빈 캐시로 시작한다", () => {
  const cache = new QuotaCache();
  assert.equal(loadCache(cache, path.join(os.tmpdir(), "없는폴더", "x.json")), false);
  assert.equal(cache.getStale("claude"), null);
});

test("깨진 파일은 무시한다", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ 이건 JSON이 아님", "utf8");
  assert.equal(loadCache(new QuotaCache(), file), false);
});

test("형식 버전이 다르면 되살리지 않는다", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ version: 99, entries: [{ key: "claude", at: 0, value: { v: 1 } }] }));
  const cache = new QuotaCache();
  assert.equal(loadCache(cache, file), false);
  assert.equal(cache.getStale("claude"), null);
});

test("스냅샷에 백오프 시각은 담지 않는다", () => {
  const cache = new QuotaCache();
  cache.put("claude", { v: 1 });
  cache.block("codex", "600");
  const snap = cache.snapshot();
  assert.deepEqual(Object.keys(snap).sort(), ["entries", "version"]);
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].key, "claude");
});

test("저장 파일에 토큰처럼 보이는 문자열이 없다", () => {
  const file = tmpFile();
  const cache = new QuotaCache();
  // 수집기가 돌려주는 모양 그대로. tokenSource는 경로 이름일 뿐 토큰이 아니다.
  cache.put("claude", {
    provider: "claude", plan: "Max 5x", tokenSource: "claude-desktop",
    weekly: { leftPercent: 84 }, tokenExpiresAt: "2026-11-13T06:40:51.078Z",
  });
  saveCache(cache, file);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!/sk-ant|Bearer |refreshToken|accessToken/.test(text), text);
});

test("BOM이 붙은 파일도 읽는다", () => {
  // Windows PowerShell의 Set-Content -Encoding utf8은 BOM을 붙인다.
  // 그걸 못 읽고 기본값으로 돌아가면 위젯이 제자리를 잃는다.
  const file = tmpFile();
  const a = new QuotaCache({ ttlMs: 60_000 });
  a.put("claude", { weekly: { leftPercent: 84 } });
  saveCache(a, file);
  fs.writeFileSync(file, "﻿" + fs.readFileSync(file, "utf8"), "utf8");

  const b = new QuotaCache({ ttlMs: 60_000 });
  assert.equal(loadCache(b, file), true);
  assert.equal(b.getFresh("claude").weekly.leftPercent, 84);
});

test("parseJsonLoose는 BOM만 걷어내고 나머지는 그대로 본다", () => {
  assert.deepEqual(parseJsonLoose('﻿{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonLoose("{ 이건 JSON이 아님"));
});
