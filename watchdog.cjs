// ===== 元枢自动守护（watchdog）v2：每 30s 检查，挂掉自动拉起，带锁文件防重复 + 重启限频 =====
const { spawn, execSync, execFileSync } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");

const PORT = 8787;
// 不写死盘符（2026-09-16，外部机器安装检查的第 1 个 bug）：脚本自身所在目录就是仓库根，
// 换盘、迁移、换机器都不用改。写死 "D:/pi-web" 时 watchdog 找不到 server.mjs，服务拉不起来。
const WEB_DIR = __dirname;
const LOCK = path.join(WEB_DIR, ".watchdog.lock");
const LOG = path.join(WEB_DIR, "watchdog.log");
let restartCount = 0;
let lastRestartAt = 0;
let child = null;
let crashTimes = []; // 最近崩溃时间戳（用于连续崩溃检测→回滚）
let rollbackDone = false; // 回滚只做一次，避免无限回滚
let lastStartAt = 0; // 最近一次启动时刻（用于分级检查频率：启动期快查，稳态慢查）

// ── 崩溃归因 → 是否回滚 ───────────────────────────────────────────────
// 回滚会把 server.mjs 换成旧的 .bak，属于「静默降级」，误判代价极高：
// 2026-09-14 实例——全局依赖 @earendil-works/pi-coding-agent 被一次中断的安装删掉，
// 服务启动即 ERR_UNSUPPORTED_DIR_IMPORT 崩溃。这与 server.mjs 代码无关；
// 若当时 watchdog 在跑并触发回滚，刚修好的 server.mjs 会被 server.mjs.bak-* 覆盖。
// 因此只回滚「能归因到 server.mjs 自身」的崩溃：语法错，或运行时 JS 错。
// 依赖缺失 / 内存溢出 / 路径不存在 / 权限等环境类崩溃一律拒绝回滚。
const ROLLBACK_AFTER = 3; // 5 分钟内连续崩溃达此数才考虑回滚
const ENV_ERROR_RE = /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|Cannot find (module|package)|ENOENT|EACCES|EPERM|JavaScript heap out of memory|heap limit|OOM/i;
const CODE_ERROR_RE = /\b(ReferenceError|SyntaxError|TypeError|RangeError)\b/;

function decideRollback({ syntaxOk = true, crashText = "", crashCount = 0, rollbackDone = false } = {}) {
  if (rollbackDone) return { rollback: false, reason: "本次进程已回滚过" };
  if (crashCount < ROLLBACK_AFTER) return { rollback: false, reason: `连续崩溃 ${crashCount} 次 < ${ROLLBACK_AFTER}` };
  // 语法坏掉 = 文件一定有问题，无条件回滚（环境类文本不能否决这一条）
  if (!syntaxOk) return { rollback: true, reason: "server.mjs 语法校验不通过" };
  const text = String(crashText || "");
  if (ENV_ERROR_RE.test(text)) return { rollback: false, reason: "环境/依赖类崩溃（非 server.mjs 代码问题），拒绝回滚" };
  if (CODE_ERROR_RE.test(text)) return { rollback: true, reason: "server.mjs 运行时报错（ReferenceError/TypeError 等）" };
  return { rollback: false, reason: "崩溃原因无法归因到 server.mjs，拒绝回滚" };
}

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN")}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + "\n"); } catch {}
}

// 锁：防止多个 watchdog 实例（旧任务+新任务同时跑会互相杀）
// 2026-08-31 加固：文件锁不原子（并发启动都过 existsSync；锁文件写坏/NaN pid 一律被当旧锁已死放行）
// → 曾积累 19 个 watchdog 互杀 60+ server。改用端口单例锁：listen 独占天然原子，进程死锁自清。
const SINGLETON_PORT = 48787;
function acquireLock() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false)); // 端口被占 = 已有实例
    srv.listen(SINGLETON_PORT, "127.0.0.1", () => {
      srv.unref(); // 不阻止退出；进程活着就一直占着锁
      try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} // 保留文件仅作信息展示
      process.on("exit", () => { try { fs.unlinkSync(LOCK); } catch {} });
      resolve(true);
    });
  });
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(2500, () => { s.destroy(); resolve(false); });
  });
}

// server.mjs 语法校验：node --check（抓语法错误，如 Missing catch、括号不匹配）
function serverSyntaxOk() {
  try {
    execFileSync(process.execPath, ["--check", "server.mjs"], { cwd: WEB_DIR, encoding: "utf8", windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch (e) {
    log("⚠️ 语法校验失败: " + String(e?.message || e).slice(0, 200));
    return false;
  }
}

// 回滚到最近的 server.mjs.bak-*（坏文件保留为 server.mjs.broken-<ts> 供分析）
// 只选语法校验通过的备份：跳过坏备份（如测试残留/回滚源本身语法错误）
function rollbackServer() {
  try {
    const files = fs.readdirSync(WEB_DIR)
      .filter(f => /^server\.mjs\.bak/.test(f))
      .map(f => ({ f, t: fs.statSync(path.join(WEB_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) { log("⚠️ 无可用备份，无法回滚"); return false; }
    let bak = null;
    for (const x of files) {
      try {
        execFileSync(process.execPath, ["--check", x.f], { cwd: WEB_DIR, stdio: "ignore" });
        bak = x.f; break;
      } catch { /* 该备份语法错误，跳过 */ }
    }
    if (!bak) { log("⚠️ 所有备份均语法错误，无法回滚"); return false; }
    const bad = path.join(WEB_DIR, `server.mjs.broken-${Date.now()}`);
    fs.renameSync(path.join(WEB_DIR, "server.mjs"), bad);
    fs.copyFileSync(path.join(WEB_DIR, bak), path.join(WEB_DIR, "server.mjs"));
    log(`🔧 已回滚 server.mjs ← ${bak}（坏文件保留: ${path.basename(bad)}）`);
    return true;
  } catch (e) { log("⚠️ 回滚失败: " + String(e?.message || e)); return false; }
}

function killPort() {
  try {
    const out = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: "utf8" });
    const pids = new Set(out.split("\n").map(l => l.trim().split(/\s+/).pop()).filter(Boolean));
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); log(`清理残留 PID ${pid}`); } catch {}
    }
  } catch {}
}

async function startServer() {
  // 防抢占（2026-08-29）：若端口已有健康 HTTP 实例（人工/其他守护启动的），不 killPort 不抢占，直接待命
  // 修复场景：双实例拉锯时 watchdog 会 killPort 杀掉正在服务的健康实例，用户会话中断
  if (await portOpen()) { log("端口已有健康实例在服务，本次跳过启动（不抢占）"); return; }
  // 重启限频：10 秒内最多重启 1 次，防死循环风暴
  const now = Date.now();
  if (now - lastRestartAt < 10000) {
    // 防风暴跳过时，若连续崩溃达阈值且能归因到 server.mjs，则回滚备份
    crashTimes = crashTimes.filter(t => now - t < 5 * 60 * 1000);
    const verdict = decideRollback({ syntaxOk: serverSyntaxOk(), crashText: "", crashCount: crashTimes.length, rollbackDone });
    if (verdict.rollback) {
      log(`⚠️ 连续崩溃且 ${verdict.reason}，自动回滚备份`);
      if (rollbackServer() && serverSyntaxOk()) { rollbackDone = true; log("✅ 回滚后语法校验通过"); }
    }
    log("⚠️ 重启过于频繁，跳过本轮（防风暴）");
    return;
  }
  lastRestartAt = now;
  // 拉起前语法体检：不过则回滚到最近备份再启动
  if (!serverSyntaxOk()) {
    log("⚠️ server.mjs 语法错误，尝试回滚备份");
    if (rollbackServer()) {
      if (!serverSyntaxOk()) { log("⚠️ 回滚后仍语法错误，跳过本轮"); return; }
      log("✅ 回滚后语法校验通过");
    } else return;
  }
  killPort();
  await new Promise(r => setTimeout(r, 2000));
  if (child) { try { child.kill(); } catch {} child = null; }
  // stdout/stderr 不再 ignore：环形缓冲最近输出，崩溃时把尾部写进 watchdog.log 留证据
  // （此前 stdio:"ignore" 把崩溃堆栈全吞了，导致运行时错误无法定位）
  let outBuf = [];
  const pushOut = (buf) => {
    const s = buf.toString("utf8");
    outBuf.push(s);
    if (outBuf.length > 200) outBuf = outBuf.slice(-200);
  };
  child = spawn("node", ["server.mjs"], { cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.on("data", pushOut);
  child.stderr.on("data", pushOut);
  lastStartAt = Date.now();
  log(`已启动 server (pid ${child.pid})，累计重启 ${restartCount} 次`);
  child.on("exit", (code, sig) => {
    const crashText = outBuf.join("").split("\n").slice(-60).join("\n");
    log(`server 退出 code=${code} signal=${sig}`);
    if (code !== 0 && outBuf.length) {
      log(`── 崩溃前最近输出 ──\n${crashText}\n── 输出结束 ──`);
    }
    child = null;
    if (code !== 0) {
      restartCount++;
      crashTimes.push(Date.now());
      crashTimes = crashTimes.filter(t => Date.now() - t < 5 * 60 * 1000);
      if (crashTimes.length >= ROLLBACK_AFTER) {
        const verdict = decideRollback({ syntaxOk: serverSyntaxOk(), crashText, crashCount: crashTimes.length, rollbackDone });
        if (verdict.rollback) {
          log(`⚠️ ${verdict.reason} → 自动回滚备份`);
          if (rollbackServer()) { rollbackDone = true; log("✅ 已回滚，准备重启"); }
        } else {
          log(`ℹ️ 不自动回滚：${verdict.reason}`);
        }
      }
      setTimeout(() => startServer(), 3000);
    }
  });
  // 启动后 15s 确认响应
  setTimeout(async () => {
    const ok = await portOpen();
    if (!ok) log("⚠️ 启动 15s 后端口仍不通");
    else log("✅ server 响应正常");
  }, 15000);
}

async function main() {
  if (!(await acquireLock())) {
    log("检测到已有 watchdog 实例（锁文件存在），本实例退出");
    process.exit(0);
  }
  log("═══ 元枢守护 v2.1 启动（分级检查：启动期 5s 快查 ×12 轮 → 稳态 30s）═══");
  if (await portOpen()) {
    log("当前 server 正常，进入监控");
  } else {
    log("当前 server 未运行，启动中…");
    startServer();
  }
  // 分级监控循环（对标 KickSide runtime 健康检查思路）：
  // - 新启动 60s 内：5s 快查（快速发现新进程早夭）
  // - 连续失败：保持快查并告警
  // - 稳态：30s 慢查
  let consecutiveFails = 0;
  const monitorLoop = async () => {
    const ok = await portOpen();
    if (!ok) {
      consecutiveFails++;
      log(`⚠️ 检测到 server 掉线（连续第 ${consecutiveFails} 次），拉起`);
      startServer();
    } else {
      consecutiveFails = 0;
    }
    const inBootWindow = Date.now() - lastStartAt < 60000;
    const delay = (inBootWindow || consecutiveFails > 0) ? 5000 : 30000;
    setTimeout(monitorLoop, delay);
  };
  monitorLoop();
}

module.exports = { decideRollback, serverSyntaxOk, rollbackServer, ROLLBACK_AFTER, ENV_ERROR_RE, CODE_ERROR_RE };

if (require.main === module) {
  main().catch((e) => { log("watchdog 启动失败: " + String((e && e.stack) || e)); process.exit(1); });
}
