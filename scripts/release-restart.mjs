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
//   node scripts/release-restart.mjs --skip-import-preflight  # 仅排障：跳过符号级导入预检
//   node scripts/release-restart.mjs --root <dir>    # 预检对象目录（默认装机目录）
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { preflightImports } from "./lib/import-preflight.mjs";

const args = process.argv.slice(2);
const PLAN = args.includes("--plan");
const KEEP_STRAY = args.includes("--keep-stray");
const SKIP_GATE = args.includes("--skip-gate");
const SKIP_IMPORT_PREFLIGHT = args.includes("--skip-import-preflight");
const argOf = (name, dflt = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(argOf("port", "8787"));
const SERVICE = argOf("service", "YuanShuService");
const INSTALL_DIR = argOf("dir", "C:\\Users\\xuexiaofeng\\AppData\\Local\\Programs\\Yuanshu\\app");
const REPO = argOf("repo", "D:\\pi-web");
const PREFLIGHT_ROOT = argOf("root", INSTALL_DIR);

const sh = (cmd, cmdArgs, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, cmdArgs, { encoding: "utf8", windowsHide: true, timeout: opts.timeout ?? 20000 }).trim() };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || "").trim(), code: e?.status ?? -1, err: String(e?.message || e).slice(0, 160) };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 2026-10-28 事故：微信里正在出图，deploy 直接重启把回合杀了
 * → 用户「说在做新图却一直没发过来」。重启前先看 inflight，最多等 waitMs。
 */
async function waitWechatIdle(waitMs) {
  const token = (() => { try { return fs.readFileSync(INSTALL_DIR + "\\.token", "utf8").trim() } catch { return "" } })();
  if (!token) return 0;
  const t0 = Date.now();
  let inflight = 0;
  while (Date.now() - t0 < waitMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/wechat/status`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json();
      inflight = Number(j?.status?.stats?.inflight ?? j?.status?.inflight ?? j?.inflight ?? 0) || 0;
    } catch { inflight = 0 }
    if (!inflight) return 0;
    if (PLAN) return inflight;
    log(`微信还在回 ${inflight} 条消息，等它跑完再重启（最多 ${Math.round(waitMs / 1000)} 秒）…`);
    await sleep(3000);
  }
  return inflight;
}
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
  log("计划：符号级导入预检 → 停服务 → 等端口释放（最多 25s）→ 残留实例（只认元枢的 server.mjs）停掉 → 起服务 → 等 health 90s → 盖章");
  process.exit(0);
}

// ── 1.5 符号级导入预检（2026-11-10：忘拷模块 ERR_MODULE_NOT_FOUND / 缺导出 failureAttribution 两起事故）──
// 放在门禁之后、停服务之前：预检不过就原地退出，老服务继续跑。
if (SKIP_IMPORT_PREFLIGHT) {
  log("⚠️ --skip-import-preflight：跳过符号级导入预检，缺文件/缺导出会推迟到服务启动时暴露");
} else {
  log(`符号级导入预检（root=${PREFLIGHT_ROOT}，entry=server.mjs）`);
  const pf = await preflightImports({
    root: PREFLIGHT_ROOT,
    entry: "server.mjs",
    timeoutMs: Number(argOf("preflight-timeout", "60000")),
  });
  if (!pf.ok) {
    for (const issue of pf.issues.slice(0, 20)) {
      const symbols = issue.symbols?.length ? `  符号: ${issue.symbols.join(", ")}` : "";
      console.log(`  · [${issue.kind}] ${issue.from || "(entry)"} -> ${issue.target}${symbols}`);
      if (issue.hint) console.log(`    ${issue.hint}`);
    }
    if (pf.issues.length > 20) console.log(`  … 另有 ${pf.issues.length - 20} 条未显示`);
    log(`⛔ 符号级导入预检不通过（${pf.issues.length} 项${pf.timedOut ? "，含超时" : ""}），拒绝重启；服务保持不动`);
    log("   确需带病重启：加 --skip-import-preflight（不推荐）");
    process.exit(6);
  }
  log(`预检通过（检查 ${pf.checked} 个文件，无法具名断言 ${pf.unknowns.length} 条）`);
}

// 2026-10-28：先把微信手上正在跑的消息等完，别把回合杀掉
const stillBusy = await waitWechatIdle(Number(argOf("wait", "90000")));
if (stillBusy) log("微信仍在忙，继续重启（被打断的消息会在启动后自动续跑）");

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
// 2026-11-07：盖章放进 finally——health 超时/脚本中断也要把当前 commit 盖上去，
// 否则装机标记停在旧 commit，前端会一直弹「发现新版本」（今天踩过一次）。
let healthy = false;
try {
  healthy = await waitHealth(PORT, 90000);
  if (!healthy) log("⛔ 90 秒内没等到 /api/health 200，去看 记忆/运行时/服务日志-*.log");
  else log("health 200");
} finally {
  // ── 5. 盖章（无条件执行）──
  try {
    const stamp = sh("node", ["scripts/stamp-build.mjs", "--dir", INSTALL_DIR, "--repo", REPO], { timeout: 30000 });
    log(stamp.ok ? stamp.out.split(/\r?\n/).filter(Boolean).join(" | ") : `盖章失败: ${stamp.err}`);
  } catch (e) {
    log(`盖章异常: ${String(e?.message || e).slice(0, 160)}`);
  }
}
if (!healthy) process.exit(5);
log("完成");
