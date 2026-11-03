// ===== self-change-session.mjs —— 隔离会话收口（2026-11-02）=====
//
// 一次自改的生命周期：
//   start  → 建独立 worktree（主树一根手指都不碰）
//   [她在这里读/改/跑测试]  ← 由 /api/runs 发起，改的是 worktree 里的文件
//   finish → 收集改动 → 自证（测试+交付门）→ 写回主树（带备份）→ 删 worktree
//   abort  → 删 worktree + 删分支，主树零影响
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (cmd, args, cwd) => new Promise((resolve) => {
  // 服务以 LocalSystem 跑，仓库属主是当前用户，git 会拒绝操作（dubious ownership）
  const a = cmd === GIT ? ["-c", "safe.directory=*", ...args] : args;
  execFile(cmd, a, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || ""), err: String(stderr || "") });
  });
});

const GIT = process.env.PI_GIT || "C:\\Program Files\\Git\\cmd\\git.exe";

export const wtPath = (wsRoot, id) => path.join(String(wsRoot), ".worktrees", `auto-${id}`);
const branchOf = (id) => `auto/${id}`;

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

/** 收口：自证 → 写回主树 → 清理。validate 由调用方注入（避免循环依赖）。 */
export async function finishSession({ wsRoot, id, validate, apply, exec = run } = {}) {
  const collected = await collectChanges({ wsRoot, id, exec });
  if (!collected.ok) return { ok: false, stage: "collect", ...collected };
  if (!collected.edits.length) { await abortSession({ wsRoot, id }); return { ok: false, stage: "collect", error: "没有任何改动" } }
  if (typeof validate !== "function") return { ok: false, stage: "validate", error: "没有自证跑法" };
  const v = await validate({ files: collected.files });
  if (!v?.ok) return { ok: false, stage: v?.stage || "validate", errors: v?.errors || ["自证未过"], files: collected.files };
  if (typeof apply !== "function") return { ok: false, stage: "apply", error: "没有写入跑法" };
  const a = await apply({ id, edits: collected.edits });
  if (!a?.ok) return { ok: false, stage: "apply", error: a?.error || "写入失败", files: collected.files };
  await abortSession({ wsRoot, id, exec }); // 保留分支与备份，删工作区
  return { ok: true, stage: "applied", id, files: collected.files, backupDir: a.backupDir };
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
