#!/usr/bin/env node
import { collectAll, createCache, loadCache, saveCache } from "../src/index.js";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const noCache = args.has("--no-cache");
const watchArg = [...args].find((a) => a.startsWith("--watch"));
const intervalSec = watchArg ? Number(watchArg.split("=")[1] || 60) : 0;

const cache = createCache();
// 매 실행이 새 프로세스라 메모리 캐시만으로는 첫 조회가 429를 맞으면 보여 줄 값이 없다.
if (!noCache) loadCache(cache);

/** 잔여%를 10칸 막대로. 색은 터미널에서만 쓴다. */
function bar(leftPercent) {
  const filled = Math.round(leftPercent / 10);
  const color = leftPercent <= 10 ? "\x1b[31m" : leftPercent <= 30 ? "\x1b[33m" : "\x1b[32m";
  return `${color}${"█".repeat(filled)}${"░".repeat(10 - filled)}\x1b[0m`;
}

function windowLine(label, w) {
  if (!w) return `  ${label.padEnd(10)} —`;
  return `  ${label.padEnd(10)} ${bar(w.leftPercent)} ${String(w.leftPercent).padStart(5)}% 남음  (리셋 ${w.resetCountdown})`;
}

function render(report) {
  const lines = [];
  for (const p of report.providers) {
    const head = [
      p.provider === "claude" ? "Claude" : "Codex",
      p.plan ? `· ${p.plan}` : "",
      p.status === "ready" ? "" : `· ${p.status.toUpperCase()}`,
    ].filter(Boolean).join(" ");
    lines.push(`\n\x1b[1m${head}\x1b[0m`);
    if (p.error) lines.push(`  \x1b[90m${p.error}\x1b[0m`);
    if (!p.weeklyOnly) lines.push(windowLine("5시간", p.session));
    lines.push(windowLine("주간", p.weekly));
    for (const [name, w] of Object.entries(p.models ?? {})) {
      if (w) lines.push(windowLine(name, w));
    }
    if (p.pace !== null && p.pace !== undefined) {
      lines.push(`  \x1b[90mpace: ${JSON.stringify(p.pace)}\x1b[0m`);
    }
    const age = p.staleAgeMs ? `, ${Math.round(p.staleAgeMs / 60_000)}분 전 실측` : "";
    if (p.tokenSource) lines.push(`  \x1b[90m소스: ${p.tokenSource}${p.cache ? ` (${p.cache}${age})` : ""}\x1b[0m`);
  }
  return lines.join("\n");
}

async function once() {
  const report = await collectAll(cache);
  if (!noCache) saveCache(cache);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(report)}\n`);
  }
  // 둘 다 숫자를 못 얻었으면 실패로 끝낸다. 스크립트에서 분기할 수 있게.
  return report.providers.some((p) => p.status === "ready" || p.status === "stale");
}

if (intervalSec > 0) {
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H");
    await once();
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
} else {
  process.exitCode = (await once()) ? 0 : 1;
}
