import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * 마지막 실측값을 디스크에 남긴다.
 *
 * 왜 필요한가: 메모리 캐시만 두면 (1) 컴퓨터를 켜서 위젯이 막 떴을 때 첫 조회가
 * 끝날 때까지 숫자가 비고, (2) 그 첫 조회가 429를 맞으면 보여 줄 값이 아예 없다.
 * 부팅 직후부터 숫자가 보여야 하므로 마지막 값을 파일에 남긴다.
 *
 * 토큰은 절대 쓰지 않는다. 정규화된 사용량(%, 리셋 시각, 플랜 이름)만 들어간다.
 */

/**
 * JSON을 너그럽게 읽는다.
 *
 * BOM이 붙은 파일을 `JSON.parse`에 그대로 넣으면 터진다. Windows PowerShell의
 * `Set-Content -Encoding utf8`을 비롯해 BOM을 붙이는 도구가 흔하다. 설정 파일
 * 하나 못 읽었다고 모든 설정이 기본값으로 돌아가면, 위젯이 제자리를 잃고
 * "가만히 뒀는데 움직였다"가 된다. 실제로 그렇게 됐다.
 */
export function parseJsonLoose(text) {
  return JSON.parse(String(text).replace(/^﻿/, ""));
}

export function defaultCachePath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
  return path.join(base, "ai-usage-collector", "last-usage.json");
}

/** @param {import("./cache.js").QuotaCache} cache */
export function loadCache(cache, file = defaultCachePath()) {
  try {
    return cache.restore(parseJsonLoose(fs.readFileSync(file, "utf8")));
  } catch {
    return false; // 파일이 없거나 깨졌으면 그냥 빈 캐시로 시작한다
  }
}

/**
 * 예측용 표본과 "이미 울린 알림" 기록.
 *
 * 따로 두는 이유: 껐다 켤 때마다 표본을 잃으면 한동안 예측을 못 하고, 울린 기록을
 * 잃으면 같은 임계값을 다시 울린다.
 */
export function forecastStatePath(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
  return path.join(base, "ai-usage-collector", "forecast-state.json");
}

export function loadForecastState(file = forecastStatePath()) {
  try {
    const d = parseJsonLoose(fs.readFileSync(file, "utf8"));
    if (d?.version !== 1) return { series: {}, fired: {} };
    return { series: d.series ?? {}, fired: d.fired ?? {} };
  } catch {
    return { series: {}, fired: {} };
  }
}

export function saveForecastState(state, file = forecastStatePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** @param {import("./cache.js").QuotaCache} cache */
export function saveCache(cache, file = defaultCachePath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 쓰는 중에 읽히면 깨진 JSON을 보게 되므로 임시 파일에 적고 바꿔 끼운다.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache.snapshot()), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // 캐시를 못 적는 것은 수집 실패가 아니다
  }
}
