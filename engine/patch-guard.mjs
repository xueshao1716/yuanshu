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
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadBaseline, summaryOf } from "./test-baseline.mjs";

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
  const session = { id, repoRoot: root, createdAt: now, allowed, entries, snapDir, closed: false };
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
export function verifyPatch({ session, testFile, full = false, timeoutMs = 600000 }) {
  const steps = [];
  const changed = changedFiles(session);
  for (const c of changed) {
    if (!/\.(mjs|cjs|js)$/.test(c.rel)) continue;
    const r = run(process.execPath, ["--check", path.join(session.repoRoot, c.rel)], session.repoRoot, 20000);
    steps.push({ name: `syntax:${c.rel}`, ok: r.ok, detail: r.ok ? "" : r.out.slice(0, 200) });
    if (!r.ok) { const rb = rollback(session); return { ok: false, rolledBack: true, steps, error: `语法错：${c.rel}` }; }
  }
  if (testFile) {
    const r = run(process.execPath, ["--test", testFile], session.repoRoot, timeoutMs);
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
      try { return fs.readdirSync(testDir).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(testDir, f)) } catch { return [] }
    })();
    if (!testFiles.length) {
      rollback(session);
      return { ok: false, rolledBack: true, steps, error: "找不到任何测试文件——门禁无法执行，已回滚" };
    }
    const r = run(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], session.repoRoot, Math.max(timeoutMs, 900000));
    const base = loadBaseline(session.repoRoot);
    const sum = summaryOf(r.out, base);
    // 测试命令挂了、又解析不出任何失败项（比如 npm 起不来）——**不能当成全绿**。
    // 这是最危险的一种假绿：门禁什么都没跑，却报告"通过"。
    if (!r.ok && sum.total === 0) {
      steps.push({ name: "test:all", ok: false, detail: r.out.slice(-200) });
      rollback(session);
      return { ok: false, rolledBack: true, steps, error: "测试命令本身失败（无可用输出），已回滚" };
    }
    steps.push({ name: "test:all", ok: sum.fresh.length === 0, detail: sum.fresh.length ? sum.fresh.join("; ") : `已知红灯 ${sum.known} 条（基线内）` });
    if (sum.fresh.length) {
      rollback(session);
      return { ok: false, rolledBack: true, steps, error: `出现 ${sum.fresh.length} 条**新增**红灯，已回滚：${sum.fresh.slice(0, 3).join("; ")}` };
    }
  }
  session.closed = true;
  session.verifiedAt = Date.now();
  try { fs.writeFileSync(path.join(session.snapDir, "session.json"), JSON.stringify(session, null, 2), "utf8"); } catch {}
  return { ok: true, rolledBack: false, steps, changed };
}
