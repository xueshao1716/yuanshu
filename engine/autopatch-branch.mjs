// ===== autopatch-branch.mjs —— 自动补丁分支的操作（2026-10-26）=====
//
// 用户原话：「怎么给我整了一堆 bash 啊，不会用啊，你能不能整成面板」
// 所以把「看 diff / 合并 / 丢弃」做成接口，面板只调接口，不让人碰命令行。
import { spawnSync } from "node:child_process";
import { gitBin } from "./repo-root.mjs";

function git(repoRoot, args) {
  const bin = gitBin() || "git";
  const r = spawnSync(bin, ["-c", `safe.directory=${repoRoot}`, ...args], {
    cwd: repoRoot, encoding: "utf8", timeout: 120000, windowsHide: true,
  });
  return { ok: r.status === 0, out: `${r.stdout || ""}${r.stderr || ""}`.trim(), code: r.status };
}

/** 列出 auto/capability-* 分支，带上改了什么。 */
export function listPatchBranches(repoRoot) {
  const list = git(repoRoot, ["branch", "--list", "auto/capability-*", "--format=%(refname:short)"]);
  if (!list.ok) return { ok: false, error: list.out.slice(0, 200) };
  const branches = list.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const items = branches.map((branch) => {
    const head = git(repoRoot, ["log", "-1", "--format=%h|%s|%ct", branch]);
    const [sha, subject, ts] = (head.out || "").split("|");
    const stat = git(repoRoot, ["diff", "--shortstat", `${branch}~1`, branch]);
    const files = git(repoRoot, ["diff", "--name-only", `${branch}~1`, branch]);
    return {
      branch,
      commit: sha || "",
      subject: (subject || "").slice(0, 100),
      at: ts ? Number(ts) * 1000 : null,
      stat: (stat.out || "").replace(/\s+/g, " ").trim(),
      files: (files.out || "").split(/\r?\n/).filter(Boolean),
    };
  });
  return { ok: true, items };
}

/** 某个分支相对主线的 diff（限长，面板里直接渲染）。 */
export function diffOfBranch(repoRoot, branch, { maxChars = 60000 } = {}) {
  const base = git(repoRoot, ["merge-base", "HEAD", branch]);
  const from = base.ok && base.out ? base.out : `${branch}~1`;
  const d = git(repoRoot, ["diff", from, branch]);
  if (!d.ok) return { ok: false, error: d.out.slice(0, 200) };
  const text = d.out.length > maxChars ? `${d.out.slice(0, maxChars)}\n…（已截断）` : d.out;
  return { ok: true, diff: text, truncated: d.out.length > maxChars };
}

/** 合并到当前分支（默认 main）。冲突就原样报告，不硬来。 */
export function mergeBranch(repoRoot, branch, { message } = {}) {
  const cur = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = cur.ok ? cur.out : "";
  if (current.startsWith("auto/")) return { ok: false, error: `当前在 ${current} 上，先切回 main 再合并` };
  const m = git(repoRoot, ["merge", "--no-ff", "-m", message || `merge ${branch}（自动补丁，人工审阅后合并）`, branch]);
  if (!m.ok) {
    // 冲突：中止合并，保持工作树干净
    git(repoRoot, ["merge", "--abort"]);
    return { ok: false, error: `合并失败（已中止）：${m.out.slice(0, 300)}` };
  }
  return { ok: true, mergedInto: current, branch };
}

/** 丢弃：删掉这个分支，改动不进入主线。 */
export function discardBranch(repoRoot, branch) {
  const cur = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (cur.out === branch) return { ok: false, error: "当前就在这个分支上，先切回 main" };
  const d = git(repoRoot, ["branch", "-D", branch]);
  return d.ok ? { ok: true, deleted: branch } : { ok: false, error: d.out.slice(0, 200) };
}
