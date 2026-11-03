// ===== self-change-main.mjs —— 主树快照模式（2026-11-03）=====
//
// 为什么有这个：工具层写根在 SDK 里不可靠（实测她只用 bash，写不到 worktree）。
// 换一条更朴素但确定可行的路：
//   ① begin：记录当前 git 脏文件基线
//   ② 她照常干活（改主树）
//   ③ finish：对比基线，得到"这次改了哪些文件"，逐个备份原文（tracked 用 git show，新文件整份存）
//   ④ rollback：tracked 回滚到 HEAD，新文件删除
// 代价：隔离性弱于 worktree；补偿：每次改动都有备份 + 一键回滚。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT = process.env.PI_GIT || "C:\\Program Files\\Git\\cmd\\git.exe";
const run = (args, cwd) => new Promise((resolve) => {
  execFile(GIT, ["-c", "safe.directory=*", ...args], { cwd, timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, err2) => {
    resolve({ ok: !err, out: String(out || ""), err: String(err2 || "") });
  });
});

const parseStatus = (txt) => String(txt || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  .map((l) => l.replace(/^[A-Z?!]{1,2}\s+/, "").replace(/^"|"$/g, "")).filter((f) => f && !f.endsWith("/"));

export async function beginSnapshot({ root }) {
  const st = await run(["status", "--porcelain"], root);
  if (!st.ok) return { ok: false, error: st.err.slice(0, 200) };
  const baseline = parseStatus(st.out);
  return { ok: true, root, baseline, at: new Date().toISOString() };
}

/** 对比基线，得到候选改动 + 备份。 */
export async function finishSnapshot({ root, backupRoot, baseline = [], id = "" }) {
  const st = await run(["status", "--porcelain"], root);
  if (!st.ok) return { ok: false, error: st.err.slice(0, 200) };
  const now = parseStatus(st.out);
  const before = new Set(baseline);
  const changed = now.filter((f) => !before.has(f));
  if (!changed.length) return { ok: false, stage: "collect", error: "没有任何改动", files: [] };

  const dir = path.join(backupRoot, id || `snap${Date.now().toString(36)}`);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (const f of changed) {
    const abs = path.join(root, f);
    const tracked = await run(["cat-file", "-e", `HEAD:${f}`], root);
    const entry = { path: f, existed: tracked.ok, tracked: tracked.ok, backup: "" };
    if (tracked.ok) {
      const show = await run(["show", `HEAD:${f}`], root);
      const bak = `${f.replace(/[\\/]/g, "__")}.bak`;
      fs.writeFileSync(path.join(dir, bak), show.out, "utf8");
      entry.backup = bak;
    }
    files.push(entry);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id, at: new Date().toISOString(), files }, null, 2), "utf8");
  return { ok: true, files: changed, backupDir: dir, manifest: { files } };
}

/** 回滚：tracked 还原到 HEAD，新文件删除。 */
export async function rollbackSnapshot({ root, backupRoot, id = "" }) {
  const dir = path.join(backupRoot, id);
  const mf = path.join(dir, "manifest.json");
  if (!fs.existsSync(mf)) return { ok: false, error: "没有快照，拒绝回滚" };
  const manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
  const restored = [];
  const failed = [];
  for (const f of manifest.files || []) {
    const abs = path.join(root, f.path);
    if (f.tracked) {
      const r = await run(["checkout", "HEAD", "--", f.path], root);
      r.ok ? restored.push(f.path) : failed.push(f.path);
    } else if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); restored.push(`${f.path}(删除)`) } catch { failed.push(f.path) }
    }
  }
  return { ok: failed.length === 0, restored, failed };
}
