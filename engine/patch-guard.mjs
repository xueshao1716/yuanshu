// ===== patch-guard.mjs —— 动代码之前先上护栏（2026-10-26）=====
//
// 下一步是"自动生成补丁"，但在那之前必须先有这两样，否则一次自动改错就可能把仓库弄脏：
//   ① 改动面限制：只允许动 PLAN 里列出来的文件（目录级要显式声明），别的一律拒绝；
//   ② 自动回滚：改完跑测试，**红了立刻还原**，并删除这次新建的文件。
//
// 几条不商量的规则：
//   · 永不碰 `.token` / `auth.json` / `记忆/` / `node_modules/` / `.git/`（这些不是"代码"，改错代价不对称）
//   · 路径必须在仓库根之内（拒绝 `../` 逃逸与绝对路径越界）
//   · 快照写进 `记忆/运行时/补丁快照/<id>/`，回滚以它为准（不依赖 git，因为工作区可能本来就脏）
//   · 回滚是**幂等的**：重复调用不会把新内容再写回去
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { loadBaseline, summaryOf } from "./test-baseline.mjs";
import { gitBin } from "./repo-root.mjs";

export const SNAPSHOT_DIR = path.join("记忆", "运行时", "补丁快照");
export const PROTECTED = [".token", "auth.json", ".env", ".git/", "node_modules/", "记忆/", "记忆\\"];

const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

const isProtected = (rel) => PROTECTED.some((p) => rel.toLowerCase().startsWith(p.toLowerCase()) || rel.toLowerCase().includes(`/${p.toLowerCase()}`));

/**
 * 由 PLAN 得出允许改动的文件集合。
 * 目录（以 / 结尾）展开成前缀白名单。
 */
export function allowedFromPlan(plan = {}) {
  const files = new Set();
  const dirs = [];
  for (const f of plan.files || []) {
    const s = String(f).replace(/\\/g, "/");
    if (s.endsWith("/")) dirs.push(s);
    else files.add(s);
  }
  return { files: [...files], dirs };
}

export function assertAllowed(repoRoot, relPath, allowed) {
  const abs = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
  if (!inside(repoRoot, abs)) return { ok: false, error: `越界：${relPath} 不在仓库内` };
  if (isProtected(rel)) return { ok: false, error: `受保护：${rel} 不允许自动改` };
  const hit = allowed.files.includes(rel) || allowed.dirs.some((d) => rel.startsWith(d));
  if (!hit) return { ok: false, error: `不在计划范围内：${rel}（计划允许：${[...allowed.files, ...allowed.dirs].join(" ")}）` };
  return { ok: true, rel };
}

function hashOf(buf) {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * 开启一次受保护的改动：校验范围 → 快照原内容。
 * @returns {{ok:boolean, session?:object, error?:string}}
 */
export function beginPatch({ repoRoot, plan, files = [], wsRoot, now = Date.now() }) {
  const root = path.resolve(repoRoot);
  const allowed = allowedFromPlan(plan);
  const targets = files.length ? files : allowed.files;
  const checked = [];
  for (const f of targets) {
    const v = assertAllowed(root, f, allowed);
    if (!v.ok) return { ok: false, error: v.error };
    checked.push(v.rel);
  }
  const id = `${now}-${Math.random().toString(36).slice(2, 8)}`;
  const snapDir = path.join(String(wsRoot || path.resolve(root, "..", "pi-workspace")), SNAPSHOT_DIR, id);
  fs.mkdirSync(snapDir, { recursive: true });
  const entries = checked.map((rel) => {
    const abs = path.join(root, rel);
    const exists = fs.existsSync(abs);
    if (exists) fs.copyFileSync(abs, path.join(snapDir, hashOf(rel) + ".bak"));
    return { rel, existed: exists, bak: exists ? path.join(snapDir, hashOf(rel) + ".bak") : null };
  });
  const session = { id, repoRoot: root, wsRoot: String(wsRoot || path.resolve(root, "..", "pi-workspace")), createdAt: now, allowed, entries, snapDir, closed: false };
  fs.writeFileSync(path.join(snapDir, "session.json"), JSON.stringify(session, null, 2), "utf8");
  return { ok: true, session };
}

/** 这次改动实际碰了哪些文件（和快照比）。 */
export function changedFiles(session) {
  return session.entries
    .map((e) => {
      const abs = path.join(session.repoRoot, e.rel);
      const exists = fs.existsSync(abs);
      if (!e.existed) return exists ? { rel: e.rel, kind: "added" } : null;
      if (!exists) return { rel: e.rel, kind: "deleted" };
      const now = fs.readFileSync(abs);
      const before = fs.readFileSync(e.bak);
      return now.equals(before) ? null : { rel: e.rel, kind: "modified" };
    })
    .filter(Boolean);
}

/** 回滚：恢复原内容、删除新建的文件。幂等。 */
export function rollback(session) {
  const restored = [];
  for (const e of session.entries) {
    const abs = path.join(session.repoRoot, e.rel);
    if (e.existed) {
      if (e.bak && fs.existsSync(e.bak)) fs.copyFileSync(e.bak, abs);
      restored.push(e.rel);
    } else if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      restored.push(`${e.rel}（新建，已删）`);
    }
  }
  session.closed = true;
  session.rolledBackAt = Date.now();
  try { fs.writeFileSync(path.join(session.snapDir, "session.json"), JSON.stringify(session, null, 2), "utf8"); } catch {}
  return { ok: true, restored };
}

/**
 * 跑子进程并等结果。**必须异步**：门禁要跑全量测试（几分钟），
 * 用 spawnSync 会把服务的事件循环堵死——健康检查失败 → watchdog 判定假死 →
 * 重启服务 → 回滚没机会执行，补丁留在工作树里（2026-10-26 真机连续两次）。
 */
function runAsync(cmd, args, cwd, timeout = 300000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL") } catch {} resolve({ ok: false, code: null, out: out + "\n[超时]" }) } }, timeout);
    child.stdout?.on("data", (d) => { out += d });
    child.stderr?.on("data", (d) => { out += d });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: null, out: out + String(e?.message || e) }) } });
    child.on("close", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, code, out }) } });
  });
}

/** 在临时 worktree 里跑一组步骤：补丁只影响那里，主工作树的脏改动不参与判定。 */
async function withWorktree(repoRoot, fn) {
  const git = gitBin() || "git";
  const tmp = path.join(os.tmpdir(), `gate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  const add = spawnSync(git, ["worktree", "add", "--detach", tmp, "HEAD"], { cwd: repoRoot, encoding: "utf8", timeout: 60000, windowsHide: true });
  if (add.status !== 0) throw new Error(`建 worktree 失败：${String(add.stderr || add.stdout).slice(0, 160)}`);

  // 2026-10-26 真机：worktree 里没有 node_modules，凡 import 第三方包的测试全崩
  // （27 个文件直接算失败）。用 junction 把依赖接进去，不复制几个 GB。
  // 根 node_modules + 各子目录的 node_modules（frontend 的 typescript 等）
  const linkTargets = [];
  // 运行时目录（git 不跟踪，但服务与测试要用）：不接过去，负责"启动服务"的测试会全崩
  const RUNTIME_DIRS = ["记忆", "bg-jobs", "feedback", "public", "app", "data", ".yuanshu"];
  const RUNTIME_FILES = [".token", "version.json"];
  for (const d of RUNTIME_DIRS) {
    const src = path.join(repoRoot, d);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) linkTargets.push({ link: path.join(tmp, d), target: src });
  }
  for (const f of RUNTIME_FILES) {
    const src = path.join(repoRoot, f);
    if (!fs.existsSync(src)) continue;
    try { fs.copyFileSync(src, path.join(tmp, f)) } catch {}
  }
  const rootModules = path.join(repoRoot, "node_modules");
  if (fs.existsSync(rootModules)) linkTargets.push({ link: path.join(tmp, "node_modules"), target: rootModules });
  try {
    for (const d of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".") || d.name === "node_modules") continue;
      const sub = path.join(repoRoot, d.name, "node_modules");
      if (fs.existsSync(sub)) linkTargets.push({ link: path.join(tmp, d.name, "node_modules"), target: sub });
    }
  } catch {}
  const linked = [];
  for (const { link, target } of linkTargets) {
    try { fs.mkdirSync(path.dirname(link), { recursive: true }) } catch {}
    if (process.platform === "win32") {
      const j = spawnSync("cmd", ["/c", "mklink", "/J", link, target], { encoding: "utf8", timeout: 30000, windowsHide: true });
      if (j.status === 0) linked.push(link);
    } else {
      try { fs.symlinkSync(target, link, "dir"); linked.push(link) } catch {}
    }
  }

  try {
    return await fn(tmp);
  } finally {
    // 先断 junction（否则删目录可能顺着链接动到真 node_modules）
    for (const link of linked) { try { spawnSync("cmd", ["/c", "rmdir", link], { timeout: 30000, windowsHide: true }) } catch {} }
    try { spawnSync(git, ["worktree", "remove", "--force", tmp], { cwd: repoRoot, encoding: "utf8", timeout: 60000, windowsHide: true }) } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

function run(cmd, args, cwd, timeout = 300000) {
  // 2026-10-26 真机踩到：在 `node --test` 里再 spawn `node --test`，
  // 子进程会继承 NODE_TEST_CONTEXT=child-v8，结果是**失败的测试也返回 0**——
  // 所有"用测试当门禁"的校验都会被它骗过（我的护栏测试就是这么假绿的）。
  // 所以跑子进程前把这套环境变量清掉。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, windowsHide: true, env });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * 验证：语法 → 指定测试 → 可选全量测试。任一步失败**自动回滚**。
 * @returns {{ok:boolean, rolledBack:boolean, steps:object[], error?:string}}
 */
export async function verifyPatch({ session, testFile, full = false, timeoutMs = 600000, isolate = false }) {
  if (isolate) return verifyIsolated({ session, testFile, full, timeoutMs });
  const steps = [];
  const changed = changedFiles(session);
  for (const c of changed) {
    if (!/\.(mjs|cjs|js)$/.test(c.rel)) continue;
    const r = await runAsync(process.execPath, ["--check", path.join(session.repoRoot, c.rel)], session.repoRoot, 20000);
    steps.push({ name: `syntax:${c.rel}`, ok: r.ok, detail: r.ok ? "" : r.out.slice(0, 200) });
    if (!r.ok) { const rb = rollback(session); return { ok: false, rolledBack: true, steps, error: `语法错：${c.rel}` }; }
  }
  if (testFile) {
    const r = await runAsync(process.execPath, ["--test", testFile], session.repoRoot, timeoutMs);
    steps.push({ name: `test:${testFile}`, ok: r.ok, detail: r.ok ? "" : r.out.slice(-300) });
    if (!r.ok) { const rb = rollback(session); return { ok: false, rolledBack: true, steps, error: `测试未过，已回滚` }; }
  }
  if (full) {
    // 用仓库自己的 test 脚本（`node --test tests/unit` 在 Node 25 会被当成模块路径而报
    // MODULE_NOT_FOUND——目录参数不可靠，直接用 npm 脚本才是"仓库认定的全量"）。
    // 2026-10-26：**只拦新增红灯**。仓库里有几条长期红的测试（配置/环境依赖），
    // 要求全绿会让门禁永远红、于是没人看——那等于没有门禁。
    // 2026-10-26 真机：spawnSync("npm.cmd", ...) 在 Windows 上直接 status=null、输出 0 字节，
    // 于是"门禁"其实什么都没跑。改成直接调 node --test + 显式文件列表（不依赖 shell/npm）。
    const testDir = path.join(session.repoRoot, "tests", "unit");
    const testFiles = (() => {
      try { return fs.readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).map((f) => "tests/unit/" + f) } catch { return [] }
    })();
    if (!testFiles.length) {
      rollback(session);
      return { ok: false, rolledBack: true, steps, error: "找不到任何测试文件——门禁无法执行，已回滚" };
    }
    const r = await runAsync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], session.repoRoot, Math.max(timeoutMs, 900000));
    // 2026-10-26：原始输出必须落盘。上一次只存了解析出的 4 个名字，
    // 结果连"是解析错还是真失败"都判断不了，只能猜。
    let gateLog = null;
    try {
      const dir = path.join(session.wsRoot || session.repoRoot, "记忆", "运行时", "门禁输出");
      fs.mkdirSync(dir, { recursive: true });
      gateLog = path.join(dir, `${session.id}-full.log`);
      fs.writeFileSync(gateLog, `# 门禁原始输出
# session: ${session.id}
# exit: ${r.code}
# at: ${new Date().toISOString()}

` + r.out, "utf8");
    } catch { gateLog = null }
    const base = loadBaseline(session.repoRoot);
    const sum = summaryOf(r.out, base);
    // 测试命令挂了、又解析不出任何失败项（比如 npm 起不来）——**不能当成全绿**。
    // 这是最危险的一种假绿：门禁什么都没跑，却报告"通过"。
    if (!r.ok && sum.total === 0) {
      steps.push({ name: "test:all", ok: false, detail: r.out.slice(-200) });
      rollback(session);
      return { ok: false, rolledBack: true, steps, gateLog, error: "测试命令本身失败（无可用输出），已回滚" };
    }
    steps.push({ name: "test:all", ok: sum.fresh.length === 0, gateLog, detail: sum.fresh.length ? sum.fresh.join("; ") : `已知红灯 ${sum.known} 条（基线内）` });
    if (sum.fresh.length) {
      rollback(session);
      return { ok: false, rolledBack: true, steps, gateLog, error: `出现 ${sum.fresh.length} 条**新增**红灯，已回滚：${sum.fresh.slice(0, 3).join("; ")}` };
    }
  }
  session.closed = true;
  session.verifiedAt = Date.now();
  try { fs.writeFileSync(path.join(session.snapDir, "session.json"), JSON.stringify(session, null, 2), "utf8"); } catch {}
  return { ok: true, rolledBack: false, steps, changed, gateLog: steps.find((x) => x.gateLog)?.gateLog || null };
}

/**
 * 崩溃/重启后的对账：找出"开了但没收尾"的补丁会话，把文件还原。
 *
 * 为什么需要：门禁跑几分钟，期间服务可能被 watchdog 重启（spawnSync 阻塞健康检查）。
 * 进程一死，rollback 就不会执行，补丁留在工作树里——2026-10-26 连续两次。
 * 迁就崩溃现实：**启动时无条件还原所有未收尾会话**。
 *
 * @returns {{restored:number, sessions:string[]}}
 */
export function reconcileDanglingSessions({ wsRoot, now = Date.now() } = {}) {
  const base = path.join(String(wsRoot || "."), SNAPSHOT_DIR);
  let dirs = [];
  try { dirs = fs.readdirSync(base) } catch { return { restored: 0, sessions: [] } }
  const restored = [];
  for (const d of dirs) {
    const file = path.join(base, d, "session.json");
    let session;
    try { session = JSON.parse(fs.readFileSync(file, "utf8")) } catch { continue }
    if (!session || session.closed) continue;
    try {
      rollback({ ...session, entries: session.entries || [] });
      session.closed = true;
      session.reconciledAt = now;
      session.reconcileReason = "startup: unfinished patch session";
      fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf8");
      restored.push(d);
    } catch { /* 单条失败不影响其它 */ }
  }
  return { restored: restored.length, sessions: restored };
}

/**
 * 隔离版校验：新建 worktree（从 HEAD）→ 把本次改动的文件复制进去 → 在那边跑语法/测试。
 *
 * 为什么必须隔离（2026-10-26 第七个坑）：直接在带**未提交改动**的工作树里跑全量测试，
 * 会把「本地脏状态」当成「补丁的影响」。真机上 3 条 git/fs 相关测试因此误红，
 * 而同样 3 条在干净树上连跑 3 遍全绿。
 */
async function verifyIsolated({ session, testFile, full = false, timeoutMs = 600000 }) {
  const steps = [];
  let gateLog = null;
  try {
    return await withWorktree(session.repoRoot, async (wt) => {
      // 把补丁带来的文件内容搬进去（worktree 是 HEAD 的干净副本）
      const changed = changedFiles(session);
      for (const c of changed) {
        const src = path.join(session.repoRoot, c.rel);
        const dst = path.join(wt, c.rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        if (c.kind === "deleted") { try { fs.rmSync(dst, { force: true }) } catch {} continue }
        fs.copyFileSync(src, dst);
      }
      for (const c of changed) {
        if (!/\.(mjs|cjs|js)$/.test(c.rel)) continue;
        const r = await runAsync(process.execPath, ["--check", path.join(wt, c.rel)], wt, 20000);
        steps.push({ name: `syntax:${c.rel}`, ok: r.ok, detail: r.ok ? "" : r.out.slice(0, 200) });
        if (!r.ok) { rollback(session); return { ok: false, rolledBack: true, steps, error: `语法错：${c.rel}` }; }
      }
      if (testFile) {
        const tf = path.join(wt, path.relative(session.repoRoot, testFile));
        const r = await runAsync(process.execPath, ["--test", fs.existsSync(tf) ? tf : testFile], wt, timeoutMs);
        steps.push({ name: `test:${path.basename(testFile)}`, ok: r.ok, detail: r.ok ? "" : r.out.slice(-300) });
        if (!r.ok) { rollback(session); return { ok: false, rolledBack: true, steps, error: "指定测试未过，已回滚" }; }
      }
      if (full) {
        const testDir = path.join(wt, "tests", "unit");
        let files = [];
        // 2026-10-26 真机：绝对路径 ×200 个把 Windows 命令行撑爆（spawn ENAMETOOLONG），
        // 改成相对路径 + cwd=worktree。
        try { files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).map((f) => "tests/unit/" + f) } catch {}
        if (!files.length) { rollback(session); return { ok: false, rolledBack: true, steps, error: "worktree 里找不到测试文件" }; }
        const r = await runAsync(process.execPath, ["--test", "--test-concurrency=1", ...files], wt, Math.max(timeoutMs, 900000));
        try {
          const dir = path.join(session.wsRoot || session.repoRoot, "记忆", "运行时", "门禁输出");
          fs.mkdirSync(dir, { recursive: true });
          gateLog = path.join(dir, `${session.id}-worktree.log`);
          fs.writeFileSync(gateLog, `# 隔离门禁输出（worktree）\n# session: ${session.id}\n# exit: ${r.code}\n\n` + r.out, "utf8");
        } catch {}
        const sum = summaryOf(r.out, loadBaseline(wt));
        if (!r.ok && sum.total === 0) {
          rollback(session);
          return { ok: false, rolledBack: true, steps, gateLog, error: "测试命令本身失败（无可用输出），已回滚" };
        }
        steps.push({ name: "test:all(worktree)", ok: sum.fresh.length === 0, gateLog, detail: sum.fresh.length ? sum.fresh.join("; ") : `已知红灯 ${sum.known} 条` });
        if (sum.fresh.length) {
          rollback(session);
          return { ok: false, rolledBack: true, steps, gateLog, error: `出现 ${sum.fresh.length} 条**新增**红灯（隔离环境），已回滚：${sum.fresh.slice(0, 3).join("; ")}` };
        }
      }
      session.closed = true;
      session.verifiedAt = Date.now();
      return { ok: true, rolledBack: false, steps, changed, gateLog };
    });
  } catch (e) {
    rollback(session);
    return { ok: false, rolledBack: true, steps, gateLog, error: `隔离门禁异常：${String(e?.message || e).slice(0, 160)}` };
  }
}
