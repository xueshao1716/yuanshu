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
  execFile(cmd, args, { cwd, timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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
  if (!r.ok) return { ok: false, error: (r.err || r.out).slice(0, 200) };
  return { ok: true, id, dir, branch: branchOf(id) };
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
  const out = [];
  if (fs.existsSync(dir)) out.push(await exec(GIT, ["worktree", "remove", "--force", dir], wsRoot));
  out.push(await exec(GIT, ["branch", "-D", branchOf(id)], wsRoot));
  return { ok: true, removed: fs.existsSync(dir) === false, results: out.map((r) => r.ok) };
}
