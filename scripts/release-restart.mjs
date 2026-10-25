#!/usr/bin/env node
// 元枢重启用一条命令：门禁 → 停服务 → 等端口真正释放（残留实例占着就停掉）→ 起服务 → 等 health → 盖章。
//
// 为什么需要它（2026-10-25 真事故）：旧实例占着 8787，新实例抢不到端口，server 空转 60 秒后
// 被看门狗当僵死重拉，形成约 10 分钟的"假死-拉起"循环；日志里每次启动都能看到
// `[实例自检] … 其它存活实例 1（pid …）`。根子是**残留实例不在服务 Job 里，sc stop 杀不到**
// （比如手工 `node server.mjs` 起的冒烟实例）。
//
// 用法：
//   node scripts/release-restart.mjs --plan          # 只看会做什么，不动手
//   node scripts/release-restart.mjs                 # 真执行
//   node scripts/release-restart.mjs --keep-stray    # 端口被残留占着时只报告、不强杀
//   node scripts/release-restart.mjs --skip-gate     # 仅排障：服务已停时门禁必然"未知"
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const PLAN = args.includes("--plan");
const KEEP_STRAY = args.includes("--keep-stray");
const SKIP_GATE = args.includes("--skip-gate");
const argOf = (name, dflt = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(argOf("port", "8787"));
const SERVICE = argOf("service", "YuanShuService");
const INSTALL_DIR = argOf("dir", "C:\\Users\\xuexiaofeng\\AppData\\Local\\Programs\\Yuanshu\\app");
const REPO = argOf("repo", "D:\\pi-web");

const sh = (cmd, cmdArgs, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, cmdArgs, { encoding: "utf8", windowsHide: true, timeout: opts.timeout ?? 20000 }).trim() };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || "").trim(), code: e?.status ?? -1, err: String(e?.message || e).slice(0, 160) };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[release] ${msg}`);

function portOwners(port) {
  const r = sh("netstat", ["-ano"]);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.out.split(/\r?\n/)) {
    // netstat -ano：协议 本地地址 外部地址 状态 PID
    // 例：  TCP    0.0.0.0:8787    0.0.0.0:0    LISTENING    22704
    // 只认 LISTENING；TIME_WAIT 行里也带端口号，但那是客户端残留，不算占用。
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(pid) && pid > 0) out.push(pid);
  }
  return [...new Set(out)];
}

function processInfo(pid) {
  const name = sh("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]).out.split(",")[0]?.replace(/"/g, "").trim() || "";
  const cmd = sh("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine) 2>$null`]).out;
  return { pid, name, cmd };
}

// 只认"确实是元枢的 server.mjs"才动手，别人家的进程一个都不碰
function ours(info) {
  return /^node(\.exe)?$/i.test(info.name) && /server\.mjs/i.test(info.cmd);
}

async function waitPortFree(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (portOwners(port).length === 0) return true;
    await sleep(1000);
  }
  return portOwners(port).length === 0;
}

async function waitHealth(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

// ── 1. 门禁 ──
log(`门禁检查（${PLAN ? "plan" : "real"}${SKIP_GATE ? "，已跳过" : ""}）`);
if (!SKIP_GATE) {
  const gate = sh("node", ["scripts/predeploy-check.mjs", "--wait", "300"], { timeout: 320000 });
  if (!gate.ok) {
    console.log(gate.out.split(/\r?\n/).slice(-6).join("\n"));
    log(`⛔ 门禁不放行（exit ${gate.code}），服务保持不动`);
    process.exit(gate.code === 2 ? 2 : 3);
  }
  log("门禁放行");
}

if (PLAN) {
  const owners = portOwners(PORT);
  log(`当前 ${PORT} 占用者: ${owners.length ? owners.map((p) => `${p}(${processInfo(p).name})`).join(", ") : "无"}`);
  log("计划：停服务 → 等端口释放（最多 25s）→ 残留实例（只认元枢的 server.mjs）停掉 → 起服务 → 等 health 90s → 盖章");
  process.exit(0);
}

// ── 2. 停服务 ──
log(`停止 ${SERVICE}`);
sh("sc.exe", ["stop", SERVICE], { timeout: 60000 });
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  if (/STOPPED/i.test(sh("sc.exe", ["query", SERVICE]).out)) break;
}

// ── 3. 等端口释放；还被占着就分辨是不是我们的残留 ──
let freed = await waitPortFree(PORT, 25000);
if (!freed) {
  const owners = portOwners(PORT);
  log(`⚠️ 服务已停，但 ${PORT} 仍被占用: ${owners.join(", ")}`);
  for (const pid of owners) {
    const info = processInfo(pid);
    log(`  pid ${pid} · ${info.name} · ${info.cmd ? info.cmd.slice(0, 90) : "(取不到命令行)"}`);
    if (!ours(info)) { log(`  跳过 pid ${pid}：看起来不是元枢的 server.mjs，不擅自杀`); continue; }
    if (KEEP_STRAY) { log(`  --keep-stray：保留 pid ${pid}`); continue; }
    const killed = sh("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    log(killed.ok ? `  已停掉残留实例 pid ${pid}（它不在服务 Job 里，sc stop 杀不到）` : `  停 pid ${pid} 失败: ${killed.err}`);
  }
  freed = await waitPortFree(PORT, 20000);
}
if (!freed) {
  log(`⛔ ${PORT} 仍被占用且不是我们的进程，拒绝启动（避免又进"假死-拉起"循环）`);
  process.exit(4);
}
log(`端口 ${PORT} 已空闲`);

// ── 4. 起服务 + 等 health ──
log(`启动 ${SERVICE}`);
sh("sc.exe", ["start", SERVICE], { timeout: 60000 });
if (!(await waitHealth(PORT, 90000))) {
  log("⛔ 90 秒内没等到 /api/health 200，去看 记忆/运行时/服务日志-*.log");
  process.exit(5);
}
log("health 200");

// ── 5. 盖章 ──
const stamp = sh("node", ["scripts/stamp-build.mjs", "--dir", INSTALL_DIR, "--repo", REPO], { timeout: 30000 });
log(stamp.ok ? stamp.out.split(/\r?\n/).filter(Boolean).join(" | ") : `盖章失败: ${stamp.err}`);
log("完成");
