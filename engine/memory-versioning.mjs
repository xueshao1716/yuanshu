// ===== memory-versioning.mjs —— 记忆的 Git 版本化（2026-10-27）=====
//
// 抄 A5 的一条：**记忆要能 diff、能回滚**。
// 元枢原来有分层/事实/整理/卫生/监听（见 memory-*.mjs），但没有"版本"——
// 记忆被改坏了只能凭记忆回忆改了什么。
//
// 实现：在 `记忆/` 下建独立 git 仓库（不污染主仓），对 memory 相关文件做提交。
// 全部 best-effort：没 git、没权限、没变化，一律只记日志，绝不抛。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitBin } from "./repo-root.mjs";

export const MEMORY_FILES = [
  "记忆.md",
  "记忆/记忆日志.md",
  "记忆/技能记忆.md",
  "记忆/自我.md",
  "记忆/工作记忆.md",
  "记忆/运行时/记忆.db",
];

const git = (cwd, args) => execFileSync(gitBin() || "git", ["-c", `safe.directory=${cwd.replace(/\\/g, "/")}`, ...args], {
  cwd, encoding: "utf8", timeout: 30000, windowsHide: true, stdio: "pipe",
});

/** 记忆仓库位置：`<wsRoot>/记忆/.memgit`（用独立 git-dir，不跟主仓混）。 */
export function memoryRepoDir(wsRoot) {
  return path.join(String(wsRoot || "."), "记忆", ".memgit");
}

function ensureRepo(wsRoot) {
  const ws = String(wsRoot || ".");
  const gitDir = memoryRepoDir(ws);
  const inited = path.join(gitDir, "HEAD");
  if (fs.existsSync(inited)) return { ws, gitDir };
  fs.mkdirSync(gitDir, { recursive: true });
  git(ws, ["--git-dir", gitDir, "--work-tree", ws, "init"]);
  // 只跟踪记忆相关文件
  const ignore = path.join(gitDir, "info");
  fs.mkdirSync(ignore, { recursive: true });
  fs.writeFileSync(path.join(ignore, "exclude"), [
    "*",
    "!记忆.md",
    "!记忆/**",
    "记忆/.memgit/**",
    "记忆/**/*.bak",
  ].join("\n"), "utf8");
  return { ws, gitDir };
}

/** 提交一次（有变化才提交）。 */
export function commitMemory({ wsRoot, message = "memory update", now = Date.now() } = {}) {
  try {
    const { ws, gitDir } = ensureRepo(wsRoot);
    const base = ["--git-dir", gitDir, "--work-tree", ws];
    git(ws, [...base, "add", "-A"]);
    const status = git(ws, [...base, "status", "--porcelain"]).trim();
    if (!status) return { ok: true, committed: false, reason: "no_change" };
    git(ws, [...base, "-c", "user.name=元枢记忆", "-c", "user.email=memory@local",
      "commit", "-m", `${String(message).slice(0, 100)} | ${new Date(now).toISOString().slice(0, 19)}`]);
    const sha = git(ws, [...base, "rev-parse", "--short", "HEAD"]).trim();
    return { ok: true, committed: true, commit: sha, files: status.split(/\r?\n/).length };
  } catch (e) {
    return { ok: false, committed: false, reason: String(e?.message || e).slice(0, 140) };
  }
}

/** 最近 N 次提交。 */
export function memoryHistory({ wsRoot, limit = 10 } = {}) {
  try {
    const { ws, gitDir } = ensureRepo(wsRoot);
    const out = git(ws, ["--git-dir", gitDir, "--work-tree", ws, "log", `-${Math.max(1, limit)}`,
      "--pretty=format:%h|%ad|%s", "--date=format:%Y-%m-%d %H:%M"]).trim();
    if (!out) return { ok: true, items: [] };
    return {
      ok: true,
      items: out.split(/\r?\n/).map((line) => {
        const [commit, at, ...rest] = line.split("|");
        return { commit, at, message: rest.join("|") };
      }),
    };
  } catch (e) {
    return { ok: false, items: [], reason: String(e?.message || e).slice(0, 140) };
  }
}

/** 回滚到某个提交（只动记忆文件）。 */
export function rollbackMemory({ wsRoot, commit } = {}) {
  const target = String(commit || "").trim();
  if (!/^[0-9a-f]{7,40}$/i.test(target)) return { ok: false, error: "commit 不合法" };
  try {
    const { ws, gitDir } = ensureRepo(wsRoot);
    const base = ["--git-dir", gitDir, "--work-tree", ws];
    // 先提交当前状态，回滚本身也可回滚
    commitMemory({ wsRoot, message: `回滚前快照（到 ${target.slice(0, 7)}）` });
    git(ws, [...base, "checkout", target, "--", "."]);
    const after = commitMemory({ wsRoot, message: `回滚到 ${target.slice(0, 7)}` });
    return { ok: true, to: target, snapshot: after.commit || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 140) };
  }
}
