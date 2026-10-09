// 「元枢」快捷方式：确认服务在跑（没跑就拉起来），再用浏览器打开并自动登录。
// 退出码：0 已打开；2 服务没起来（open.vbs 据此弹窗提示）。
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { ROOT, APP } = require("./service.cjs");

const PORT = Number(process.env.YUANSHU_PORT || 8787);
const TOKEN_FILE = path.join(APP, ".token");
const quiet = process.argv.includes("--service-only");

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/api/health", timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); } catch { resolve(false); } });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function startService() {
  const r = spawnSync("schtasks.exe", ["/Run", "/TN", "yuanshu-watchdog"], { windowsHide: true });
  if (r.status === 0) return "task";
  // 计划任务不可用（被策略禁用等）时直接起一个后台守护
  const child = spawn(process.execPath, [path.join(__dirname, "service.cjs")], { cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return "direct";
}

async function main() {
  if (!(await health())) {
    startService();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !(await health())) await new Promise((r) => setTimeout(r, 1000));
    if (!(await health())) process.exit(2);
  }
  if (quiet) return;
  let token = "";
  try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch {}
  // 2026-10-08 token 可以是任意可打印字符（非纯十六进制），只要非空就带上 #t= 实现自动登录
  // 2026-10-08 fix: 不能对整个 token 做 encodeURIComponent，因为 URL 中 # 会截断 location.hash
  // 只过滤非打印字符，直接拼入；hash-token.mjs 正则 .{8,256} 可匹配任意可打印字符
  const safeToken = token.replace(/[^\x20-\x7E]/g, '').trim();
  const url = `http://127.0.0.1:${PORT}/` + (safeToken ? `#t=${safeToken}` : "");
  spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

main().catch(() => process.exit(2));
