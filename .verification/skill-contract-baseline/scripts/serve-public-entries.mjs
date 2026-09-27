// ══ 外网入口的本地服务守护（2026-09-18）══════════════════════════════════
// 起因：cloudflared 隧道是好的，但 share.myxinyu.xin / novel.myxinyu.xin 报 502——
// 因为这两个域名指向的**本地服务**（分享服务器 8644、小说工作台 8790）没在跑，
// 而它们此前只在手动启动时存在（元枢有自己的 watchdog，这两个没有）。
//
// 这个脚本按隧道配置把两个本地服务拉起来：
//   share.myxinyu.xin → 127.0.0.1:8644 → D:\pi-workspace\外网分享\server.js (PORT=8644)
//   novel.myxinyu.xin → 127.0.0.1:8790 → D:\novel-studio\server.mjs
// 幂等：端口已经在听就跳过（不再重复 bind，也不会出现两个进程抢同一个端口）。
// 用法：node scripts/serve-public-entries.mjs [--check]
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const LOG_DIR = path.join(process.env.PI_WORKSPACE || "D:\\pi-workspace", "记忆", "运行时");
const ENTRIES = [
  {
    name: "外网分享",
    port: 8644,
    cwd: path.join(process.env.PI_WORKSPACE || "D:\\pi-workspace", "外网分享"),
    script: "server.js",
    env: { PORT: "8644" },
  },
  {
    name: "小说工作台",
    port: 8790,
    cwd: "D:\\novel-studio",
    script: "server.mjs",
    env: {},
  },
];

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.setTimeout(1500, () => done(false));
  });
}

const onlyCheck = process.argv.includes("--check");
const results = [];
for (const e of ENTRIES) {
  const alive = await portOpen(e.port);
  if (alive) { results.push({ ...e, action: "已在运行（跳过）" }); continue; }
  if (!fs.existsSync(path.join(e.cwd, e.script))) { results.push({ ...e, action: `找不到 ${path.join(e.cwd, e.script)}` }); continue; }
  if (onlyCheck) { results.push({ ...e, action: "未运行（--check 只报告）" }); continue; }
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const out = fs.openSync(path.join(LOG_DIR, `外网入口-${e.port}.log`), "a");
  const child = spawn(process.execPath, [e.script], {
    cwd: e.cwd,
    env: { ...process.env, ...e.env },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  results.push({ ...e, action: `已启动（pid ${child.pid}）` });
}

for (const r of results) console.log(`[外网入口] ${r.name} :${r.port} → ${r.action}`);
const down = [];
for (const e of ENTRIES) if (!(await portOpen(e.port))) down.push(`${e.name}:${e.port}`);
if (down.length) { console.log(`[外网入口] ⚠️ 仍未就绪：${down.join(", ")}（看 ${path.join(LOG_DIR, "外网入口-*.log")}）`); process.exit(1); }
console.log("[外网入口] 两个本地服务都在听（8644 / 8790）");
