// engine/share-api.mjs —— 分享管理（LEGACY，2026-08-20 从 server.mjs 拆出）
// 现分享由外部分享服务器 + 隧道统一管理；此处保留兼容接口
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { json } from "./http-utils.mjs";
import { wsSafePath } from "./workspace-api.mjs";
import { env } from "./env.mjs";

// ── 分享管理（LEGACY，保留兼容：现分享由外部分享服务器 node server.js + 隧道统一管理）──
// 说明：前端已无调用入口；域名通过环境变量 YUANSHU_SHARE_HOST（旧名 PI_WEB_SHARE_HOST）配置，
// 开源环境可留空（仅本地访问）
const SHARE_PORT = 8642;
const SHARE_HOST = env("SHARE_HOST") || "";
let shareProcess = null; // 当前分享的 http.server 子进程
let sharePath = null;    // 分享的目录

// 启动分享：python -m http.server 8642 --directory <path>
export function startShare(dir) {
  return new Promise((resolve) => {
    try {
      // 先停掉旧的（幂等）
      stopShareSync();
      const child = spawn("python", ["-m", "http.server", String(SHARE_PORT), "--directory", dir], {
        cwd: dir, windowsHide: true, stdio: "ignore", detached: false,
      });
      shareProcess = child;
      sharePath = dir;
      child.on("error", (e) => { console.log(`[元枢] 分享启动失败: ${e.message}`); });
      child.on("exit", (code) => { if (shareProcess === child) { shareProcess = null; sharePath = null; console.log(`[元枢] 分享已停止 (code ${code})`); } });
      // 等端口就绪
      const t = Date.now();
      const check = setInterval(() => {
        const net = require("node:net");
        const s = net.connect(SHARE_PORT, "127.0.0.1");
        s.on("connect", () => { s.destroy(); clearInterval(check); resolve({ ok: true, url: `https://${SHARE_HOST}/`, path: dir }); });
        s.on("error", () => { if (Date.now() - t > 5000) { clearInterval(check); resolve({ ok: false, error: "启动超时" }); } });
      }, 300);
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e).slice(0, 100) });
    }
  });
}
export function stopShareSync() {
  if (shareProcess) {
    try { shareProcess.kill(); } catch {}
    shareProcess = null;
  }
  sharePath = null;
}

// POST /api/share {path} —— 分享工作空间内目录
export async function handleShare(res, body) {
  const p = String(body?.path || "");
  if (!p) return json(res, 400, { error: "缺少路径" });
  const safe = wsSafePath(p);
  if (!safe || !fs.existsSync(safe) || !fs.statSync(safe).isDirectory()) return json(res, 404, { error: "目录不存在" });
  const r = await startShare(safe);
  if (r.ok) json(res, 200, { ok: true, url: r.url, path: r.path, port: SHARE_PORT });
  else json(res, 500, { error: r.error || "启动失败" });
}
// GET /api/share/status
export function handleShareStatus(res) {
  json(res, 200, { sharing: !!shareProcess, path: sharePath, url: shareProcess ? `https://${SHARE_HOST}/` : null, port: SHARE_PORT });
}
// POST /api/share/stop
export function handleShareStop(res) {
  stopShareSync();
  json(res, 200, { ok: true, sharing: false });
}
