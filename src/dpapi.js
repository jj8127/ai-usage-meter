import { spawn } from "node:child_process";
import path from "node:path";

// Windows DPAPI CryptUnprotectData. Node에 바인딩이 없어 PowerShell을 한 번 띄운다.
// 키는 argv나 파일을 거치지 않고 stdin/stdout으로만 오간다 (프로세스 목록 노출 방지).
const SCRIPT = `$ErrorActionPreference='Stop'; try {
  Add-Type -AssemblyName System.Security
  $wrapped=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  $key=[Security.Cryptography.ProtectedData]::Unprotect($wrapped,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($key))
  [Array]::Clear($key,0,$key.Length)
} catch { exit 1 }`;

function powershellPath() {
  const root = process.env.SystemRoot;
  return root
    ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/**
 * @param {Buffer} wrapped DPAPI blob (앞 5바이트 "DPAPI" 접두사는 제거한 상태)
 * @param {number} expectedBytes 기대하는 평문 길이. 안 맞으면 실패로 본다.
 * @returns {Promise<Buffer>}
 */
export function unprotect(wrapped, expectedBytes = 32) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("DPAPI는 Windows에서만 쓸 수 있습니다"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 5000, stdio: ["pipe", "pipe", "ignore"] }
    );

    let out = "";
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      reject(new Error(msg || "DPAPI 복호화 실패"));
    };

    child.on("error", () => fail());
    child.stdin.on("error", () => fail());
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (out.length > 1024) { child.kill(); fail("DPAPI 출력이 비정상적으로 큽니다"); }
    });
    child.on("close", (code) => {
      if (settled) return;
      const key = Buffer.from(out.trim(), "base64");
      out = "";
      if (code === 0 && key.length === expectedBytes) { settled = true; resolve(key); }
      else { key.fill(0); fail(`DPAPI 복호화 실패 (exit=${code}, ${key.length}B)`); }
    });
    child.stdin.end(wrapped.toString("base64"));
  });
}
