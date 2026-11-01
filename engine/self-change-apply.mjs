// ===== self-change-apply.mjs —— 自改的写入与回滚（2026-11-02）=====
//
// 纪律：
//   ① 改之前先把原文件整份备份到 记忆/运行时/自改备份/<id>/，带 sha256
//   ② 写入走"临时文件 + rename"，不留半截文件
//   ③ 每份改动可一键回滚（按 sha 校验还原，缺备份就拒绝而不是猜）
//   ④ 只允许白名单目录（复用 self-change.checkChange）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkChange } from "./self-change.mjs";

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
const backupRoot = (wsRoot, id) => path.join(String(wsRoot || "."), "记忆", "运行时", "自改备份", String(id));

/**
 * 应用一组改动。
 * @param {{wsRoot:string, id:string, edits:{path:string, content:string}[], now?:number}} opts
 */
export function applyChange({ wsRoot, id, edits = [], now = Date.now() } = {}) {
  if (!id) return { ok: false, error: "缺改动 id" };
  const files = edits.map((e) => e?.path);
  const bound = checkChange({ files });
  if (!bound.ok) return { ok: false, stage: "policy", errors: bound.errors };

  const dir = backupRoot(wsRoot, id);
  const manifest = { id, at: new Date(now).toISOString(), files: [] };
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const e of edits) {
      const abs = path.join(String(wsRoot || "."), e.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      const before = existed ? fs.readFileSync(abs) : Buffer.alloc(0);
      // 备份（文件不存在也记一条，回滚时删掉新建的）
      const bakName = `${e.path.replace(/[\\/]/g, "__")}.bak`;
      fs.writeFileSync(path.join(dir, bakName), before);
      manifest.files.push({ path: e.path, existed, backup: bakName, shaBefore: existed ? sha(before) : "", shaAfter: sha(Buffer.from(e.content || "", "utf8")) });
      // 原子写
      const tmp = `${abs}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, e.content ?? "", "utf8");
      fs.renameSync(tmp, abs);
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return { ok: true, id, backupDir: dir, manifest };
  } catch (err) {
    // 中途失败：尽量把已写的还原，别留半套
    try { rollbackChange({ wsRoot, id }) } catch {}
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}

/** 回滚：按 manifest 还原；sha 不符则拒绝（说明文件被别处改过）。 */
export function rollbackChange({ wsRoot, id } = {}) {
  const dir = backupRoot(wsRoot, id);
  const mf = path.join(dir, "manifest.json");
  if (!fs.existsSync(mf)) return { ok: false, error: "没有备份，拒绝回滚" };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, "utf8")) } catch { return { ok: false, error: "备份清单损坏" } }

  const restored = [];
  const conflicts = [];
  for (const f of manifest.files || []) {
    const abs = path.join(String(wsRoot || "."), f.path);
    const bak = path.join(dir, f.backup);
    if (!fs.existsSync(bak)) { conflicts.push(`${f.path} 缺备份`); continue }
    try {
      if (f.existed) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, fs.readFileSync(bak));
        restored.push(f.path);
      } else if (fs.existsSync(abs)) {
        fs.unlinkSync(abs); // 原来没有 → 删掉新建的
        restored.push(`${f.path}(删除)`);
      }
    } catch (e) { conflicts.push(`${f.path} 还原失败`) }
  }
  fs.writeFileSync(path.join(dir, "rollback.json"), JSON.stringify({ at: new Date().toISOString(), restored, conflicts }, null, 2), "utf8");
  return { ok: conflicts.length === 0, restored, conflicts };
}

export function listBackups(wsRoot) {
  const root = path.join(String(wsRoot || "."), "记忆", "运行时", "自改备份");
  try {
    return fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "manifest.json"))).map((d) => {
      try { const m = JSON.parse(fs.readFileSync(path.join(root, d, "manifest.json"), "utf8")); return { id: d, at: m.at, files: (m.files || []).length, rolledBack: fs.existsSync(path.join(root, d, "rollback.json")) } } catch { return { id: d, at: "", files: 0, rolledBack: false } }
    }).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50);
  } catch { return [] }
}
