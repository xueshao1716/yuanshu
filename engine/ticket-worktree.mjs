// ===== ticket-worktree.mjs —— 派活各用一棵 worktree（2026-11-07）=====
//
// 从 worktrunk（GitHub Trending 里那类工具）借的做法：并行 Agent 各自一棵 worktree，
// 主树一根手指都不碰。元枢里自改（self-change-session）已经有这套，但那是"她改自己"；
// 派出去干活的任务还没有目录隔离，几个任务同时改一个仓库会互相踩。
//
// 这里只做三件事，不碰主树、不自动合并：
//   start  —— git worktree add .worktrees/agent-<ticketId> -b agent/<ticketId>
//   status —— 这棵树有没有未提交改动
//   close  —— 干净的树才自动删；有改动就留着，等人看过（绝不硬删）
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const GIT = ["C:\\Program Files\\Git\\cmd\\git.exe", "git"].find((p) => p === "git" || fs.existsSync(p)) || "git";

export function worktreeDir(wsRoot, ticketId) {
  return path.join(String(wsRoot || "."), ".worktrees", `agent-${String(ticketId || "").replace(/[^A-Za-z0-9._-]+/g, "-")}`);
}

export function branchOf(ticketId) {
  return `agent/${String(ticketId || "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

function git(cwd, args) {
  try {
    const out = execFileSync(GIT, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: String(out || "").trim() };
  } catch (e) {
    const err = String(e?.stderr || e?.message || e).slice(0, 400);
    return { ok: false, error: err };
  }
}

/** 开一棵工单树。已存在就复用（幂等）。 */
export function startTicketWorktree(wsRoot, ticketId, { base = "" } = {}) {
  const id = String(ticketId || "").trim();
  if (!id) return { ok: false, error: "缺 ticketId" };
  const dir = worktreeDir(wsRoot, id);
  if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(dir)) return { ok: true, dir, reused: true };
  const args = ["worktree", "add", dir, "-b", branchOf(id)];
  if (base) args.push(String(base));
  const r = git(wsRoot, args);
  if (!r.ok) return { ok: false, error: r.error, dir };
  return { ok: true, dir, reused: false };
}

/** 这棵树当前有没有未提交改动。 */
export function ticketWorktreeStatus(wsRoot, ticketId) {
  const dir = worktreeDir(wsRoot, ticketId);
  if (!fs.existsSync(dir)) return { exists: false, dirty: false, changed: 0 };
  const r = git(dir, ["status", "--porcelain"]);
  if (!r.ok) return { exists: true, dirty: true, changed: 0, error: r.error };
  const changed = r.out ? r.out.split("\n").filter(Boolean).length : 0;
  return { exists: true, dirty: changed > 0, changed };
}

/**
 * 收尾：干净的树删掉；有改动就留着并如实说（等人审，不硬删、不自动合）。
 * @returns {{ ok:boolean, removed:boolean, kept:boolean, dir:string, changed:number, detail:string }}
 */
export function closeTicketWorktree(wsRoot, ticketId) {
  const id = String(ticketId || "").trim();
  const dir = worktreeDir(wsRoot, id);
  const st = ticketWorktreeStatus(wsRoot, id);
  if (!st.exists) return { ok: true, removed: false, kept: false, dir, changed: 0, detail: "没有这棵树" };
  if (st.dirty) return { ok: true, removed: false, kept: true, dir, changed: st.changed, detail: `有 ${st.changed} 处改动，留着等人审` };
  const rm = git(wsRoot, ["worktree", "remove", dir, "--force"]);
  if (!rm.ok) return { ok: false, removed: false, kept: true, dir, changed: 0, detail: rm.error };
  git(wsRoot, ["branch", "-D", branchOf(id)]);
  return { ok: true, removed: true, kept: false, dir, changed: 0, detail: "干净，已删除" };
}
