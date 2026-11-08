// ===== self-change-session.mjs —— 隔离会话收口（2026-11-02）=====
//
// 一次自改的生命周期：
//   start  → 建独立 worktree（主树一根手指都不碰）
//   [她在这里读/改/跑测试]  ← 由 /api/runs 发起，改的是 worktree 里的文件
//   finish → 收集改动 → 自证（测试+交付门）→ 写回主树（带备份）→ 准入闸 → 删 worktree
//   abort  → 删 worktree + 删分支，主树零影响
//
// 2026-11-08 接闸：
//   · 写回前必须 verifyChange（语法 / import / 相关测试 / 无夹带）通过，否则主树一根手指都不碰；
//   · 写回后必须 admit（自证记录 + filesetHash + 夹带检查 + git add/commit）通过，被拒就按备份回滚；
//   · requireAdmission !== false 默认开启，只有测试/紧急排障才显式关掉（返回值会记录"已跳过准入"）。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { verifyChange } from "./self-change-verify.mjs";
import { admit as admitChange, recordVerification } from "./self-change-admit.mjs";
import { rollbackChange } from "./self-change-apply.mjs";

const run = (cmd, args, cwd) => new Promise((resolve) => {
  // 服务以 LocalSystem 跑，仓库属主是当前用户，git 会拒绝操作（dubious ownership）
  const a = cmd === GIT ? ["-c", "safe.directory=*", ...args] : args;
  execFile(cmd, a, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || ""), err: String(stderr || "") });
  });
});

const GIT = process.env.PI_GIT || "C:\\Program Files\\Git\\cmd\\git.exe";

export const wtPath = (wsRoot, id) => path.join(String(wsRoot), ".worktrees", `auto-${id}`);
export const branchOf = (id) => `auto/${id}`;

/** 建隔离工作区。 */
export async function startSession({ wsRoot, id, exec = run } = {}) {
  if (!id) return { ok: false, error: "缺 id" };
  const dir = wtPath(wsRoot, id);
  if (fs.existsSync(dir)) return { ok: false, error: "该会话已存在" };
  const r = await exec(GIT, ["worktree", "add", dir, "-b", branchOf(id)], wsRoot);
  const dirExists = fs.existsSync(dir);
  const branch = await exec(GIT, ["rev-parse", "--verify", branchOf(id)], wsRoot);
  const trace = {
    code: r.code,
    stdout: String(r.out || "").slice(-300),
    stderr: String(r.err || "").slice(-300),
    dirExists,
    branchExists: branch.ok,
  };
  // 只有真建出来才算成功
  if (!r.ok || !dirExists) {
    return { ok: false, error: r.err || r.out || "git worktree add 没建出目录", trace };
  }
  return { ok: true, id, dir, branch: branchOf(id), trace };
}

/** 收集 worktree 里的改动（相对路径 + 内容）。 */
export async function collectChanges({ wsRoot, id, exec = run, maxFiles = 5, maxBytes = 60 * 1024 } = {}) {
  const dir = wtPath(wsRoot, id);
  if (!fs.existsSync(dir)) return { ok: false, error: "没有这个会话" };
  const st = await exec(GIT, ["status", "--porcelain"], dir);
  if (!st.ok) return { ok: false, error: "读不到改动" };
  const files = st.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^[A-Z?!]{1,2}\s+/, "").replace(/^"|"$/g, ""))
    .filter((f) => f && !f.endsWith("/"));
  if (files.length > maxFiles) return { ok: false, error: `改了 ${files.length} 个文件，超过上限 ${maxFiles}`, files };
  const edits = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs)) return { ok: false, error: `删除文件不在允许范围：${f}`, files };
    const buf = fs.readFileSync(abs);
    if (buf.length > maxBytes) return { ok: false, error: `文件过大：${f}` };
    edits.push({ path: f, content: buf.toString("utf8") });
  }
  return { ok: true, files, edits };
}

/** 失败可诊断：找出第一处没通过的步骤（含"全是 skipped"的没证据情况）。 */
const firstFailedStep = (verdict) => {
  const steps = Array.isArray(verdict?.steps) ? verdict.steps : [];
  const bad = steps.find((s) => s?.ok === false);
  if (bad) return String(bad.name || "unknown");
  const substantive = steps.filter((s) => s?.name !== "deps" && !s?.skipped);
  return substantive.length ? "" : "no-evidence";
};

const worktreeState = (wsRoot, id) => {
  const dir = wtPath(wsRoot, id);
  return { dir, branch: branchOf(id), exists: fs.existsSync(dir) };
};

const safeRollback = async (fn, args) => {
  try {
    const r = await fn(args);
    return r && typeof r === "object" ? r : { ok: !!r };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
};

/**
 * 收口：自证 → 写回主树 → 准入闸 → 清理。
 * validate 由调用方注入（避免循环依赖）；verify/admit 默认用真闸，测试可注入。
 * @param {{wsRoot:string,id:string,validate?:Function,apply?:Function,exec?:Function,
 *   verify?:Function,admit?:Function,rollback?:Function,repoRoot?:string,
 *   requireAdmission?:boolean,note?:string,now?:number,run?:Function}} opts
 */
export async function finishSession({
  wsRoot, id, validate, apply, exec = run,
  verify = verifyChange,
  admit = admitChange,
  rollback = rollbackChange,
  repoRoot,
  requireAdmission = true,
  note = "",
  now = Date.now(),
  run: runner,
} = {}) {
  if (!id) return { ok: false, stage: "collect", error: "缺 id" };
  const collected = await collectChanges({ wsRoot, id, exec });
  const worktree = worktreeState(wsRoot, id);
  if (!collected.ok) return { ok: false, stage: "collect", ...collected, worktree };
  const files = collected.files;
  if (!collected.edits.length) {
    await abortSession({ wsRoot, id, exec });
    return { ok: false, stage: "collect", error: "没有任何改动", files, worktree };
  }
  const mainRoot = path.resolve(String(repoRoot || wsRoot || "."));
  const writeRoot = String(wsRoot || repoRoot || ".");
  const verifyFn = typeof verify === "function" ? verify : verifyChange;
  const admitFn = typeof admit === "function" ? admit : admitChange;
  const rollbackFn = typeof rollback === "function" ? rollback : rollbackChange;

  // 旧门（测试 + 交付门）：保留原有语义，先跑；失败仍按原 stage 返回
  if (typeof validate === "function") {
    let v;
    try {
      v = await validate({ files });
    } catch (e) {
      v = { ok: false, stage: "validate", errors: [`测试/交付门异常：${String(e?.message || e).slice(0, 200)}`] };
    }
    if (!v?.ok) {
      return {
        ok: false, stage: v?.stage || "validate", failedStep: v?.stage || "validate",
        errors: v?.errors || ["自证未过"], files, verdict: v, filesetHash: "", worktree,
        hint: `测试/交付门未过，未写回主树；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
      };
    }
  }
  if (typeof apply !== "function") return { ok: false, stage: "apply", error: "没有写入跑法", files, filesetHash: "", worktree };

  // ① 写回前自证：在隔离 worktree 里跑；filesetHash 只看相对路径+内容，所以主树可复用这份证明
  let verdict;
  try {
    verdict = await verifyFn({ repoRoot: worktree.dir, files, run: runner, now });
  } catch (e) {
    const detail = `自证器异常：${String(e?.message || e).slice(0, 200)}`;
    verdict = { ok: false, filesetHash: "", files, steps: [{ name: "verify", ok: false, detail }], reason: detail };
  }
  const filesetHash = String(verdict?.filesetHash || "");
  if (!verdict?.ok) {
    const failedStep = firstFailedStep(verdict);
    return {
      ok: false, stage: "verify", verdict, filesetHash, failedStep,
      errors: Array.isArray(verdict?.errors) && verdict.errors.length ? verdict.errors : [verdict?.reason || "自证未过"],
      files, worktree,
      hint: `自证未过（${failedStep || "见 verdict"}），未写回主树；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
    };
  }
  if (!filesetHash) {
    return {
      ok: false, stage: "verify", verdict, filesetHash: "", failedStep: "fileset",
      errors: ["自证没有给出 filesetHash，无法锁定这套文件"],
      files, worktree,
      hint: `自证缺少 filesetHash，未写回主树；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
    };
  }

  // ② 写回主树（apply 自带"写前备份"；失败时主树不动）
  let a;
  try {
    a = await apply({ id, files, edits: collected.edits });
  } catch (e) {
    a = { ok: false, error: `写入异常：${String(e?.message || e).slice(0, 200)}` };
  }
  if (!a?.ok) {
    return {
      ok: false, stage: "apply", error: a?.error || "写入失败", applyStage: a?.stage,
      files, filesetHash, verdict, worktree,
      hint: `写回失败，主树未改；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
    };
  }

  // ③ 自证记录落账：准入闸只认账本，不认调用方口头 ok
  let recorded;
  try {
    recorded = recordVerification(writeRoot, {
      ...verdict,
      files: Array.isArray(verdict.files) && verdict.files.length ? verdict.files : files,
    }, { now });
  } catch (e) {
    recorded = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  // ④ 准入闸：默认必须过；显式关闭只给测试/紧急排障，并把"已跳过"写进返回值
  if (requireAdmission === false) {
    await abortSession({ wsRoot, id, exec });
    return {
      ok: true, stage: "applied", id, files, filesetHash, verdict, backupDir: a.backupDir,
      admission: {
        ok: false, skipped: true, code: "skipped",
        reason: "requireAdmission:false，已跳过准入（仅限测试/紧急排障）",
      },
      notes: ["已跳过准入（requireAdmission:false）"],
      worktree: worktreeState(wsRoot, id),
    };
  }

  if (!recorded?.ok) {
    const rolledBack = await safeRollback(rollbackFn, { wsRoot: writeRoot, id });
    return {
      ok: false, stage: "admit", code: "no_record",
      reason: `自证记录落盘失败，无法准入：${recorded?.error || "未知错误"}`,
      admission: null, filesetHash, verdict, files, rolledBack, worktree,
      hint: `自证记录没写进账本，已${rolledBack.ok ? "回滚" : "尝试回滚"}写回；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
    };
  }

  let admission;
  try {
    admission = await admitFn({ repoRoot: mainRoot, files, verdict, wsRoot: writeRoot, now, note, run: runner });
  } catch (e) {
    admission = { ok: false, code: "admit_error", reason: `准入闸异常：${String(e?.message || e).slice(0, 200)}` };
  }

  if (!admission?.ok) {
    const rolledBack = await safeRollback(rollbackFn, { wsRoot: writeRoot, id });
    return {
      ok: false, stage: "admit",
      code: admission?.code || "admit_failed",
      reason: admission?.reason || "准入被拒",
      admission, filesetHash, verdict, files, rolledBack, worktree,
      hint: `准入被拒（${admission?.code || "admit_failed"}），已${rolledBack.ok ? "回滚" : "尝试回滚但未完全成功"}写回；改动仍在 ${worktree.dir}（分支 ${worktree.branch}）`,
    };
  }

  await abortSession({ wsRoot, id, exec });
  return {
    ok: true, stage: "applied", id, files, filesetHash, verdict, admission,
    commit: admission.commit, backupDir: a.backupDir,
    worktree: worktreeState(wsRoot, id),
  };
}

/** 放弃：删工作区与分支，主树无感。 */
export async function abortSession({ wsRoot, id, exec = run } = {}) {
  const dir = wtPath(wsRoot, id);
  const trace = [];
  const mark = (step, extra = {}) => trace.push({ step, exists: fs.existsSync(dir), ...extra });

  mark("start");
  if (fs.existsSync(dir)) {
    const r = await exec(GIT, ["worktree", "remove", "--force", dir], wsRoot);
    mark("git-worktree-remove", { ok: r.ok, code: r.code, err: String(r.err || "").slice(0, 200) });
  } else {
    mark("skip-remove");
  }

  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { mark("rmSync-error", { err: String(e?.message || e).slice(0, 120) }) }
    mark("rmSync");
  }

  if (fs.existsSync(dir)) {
    const r = await exec("cmd.exe", ["/c", "rmdir", "/s", "/q", dir], wsRoot);
    mark("rmdir", { ok: r.ok, code: r.code, err: String(r.err || "").slice(0, 200) });
  }

  const prune = await exec(GIT, ["worktree", "prune"], wsRoot);
  mark("prune", { ok: prune.ok, code: prune.code, err: String(prune.err || "").slice(0, 160) });

  const delBranch = await exec(GIT, ["branch", "-D", branchOf(id)], wsRoot);
  mark("branch-delete", { ok: delBranch.ok, code: delBranch.code, err: String(delBranch.err || "").slice(0, 160) });

  return { ok: true, removed: fs.existsSync(dir) === false, trace };
}
