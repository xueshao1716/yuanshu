// engine/pending-api.mjs —— 「待审改动」（2026-09-20）
// 由来：openwriter（github.com/travsteward/openwriter, MIT）的核心设计是"agent 写字、人审阅"：
//       改动先以 diff 到达，接受/拒绝一次按键。我们把它落成元枢的机制：
//       agent（或我）改文件前，先把"目标文件 + 新内容 + diff"写进 工程/待审/<id>.json；
//       人在工作台「改动验收」里逐条 接受/拒绝；接受才真正写盘，并留审计。
import fs from "node:fs";
import path from "node:path";
import { createHash } from 'node:crypto';
import { reviewPath, reviewAudit, reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');

const MAX_DIFF_CHARS = 20000;

function pendingDir(wsRoot) { return reviewStoragePath(wsRoot, '工程/待审'); }

function rid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function unifiedDiff(before, after, label = "") {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > 1_000_000) return { text: '大文件：差异预览已截断，请核对完整提议内容。\n' + String(after).slice(0, MAX_DIFF_CHARS), added: null, removed: null, label, truncated: true };
  // 朴素 LCS 行级 diff（文件级场景够用；超长自动截断）
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push("  " + a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push("- " + a[i]); i++; }
    else { out.push("+ " + b[j]); j++; }
  }
  while (i < n) out.push("- " + a[i++]);
  while (j < m) out.push("+ " + b[j++]);
  const text = out.join("\n");
  return { text: text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) + "\n…（已截断）" : text, added: out.filter((l) => l.startsWith("+ ")).length, removed: out.filter((l) => l.startsWith("- ")).length, label };
}

export function createPendingApi({ wsRoot, json, readBody }) {
  const fileFor = id => reviewStoragePath(wsRoot, `工程/待审/${id}.json`);
  const load = (id) => { if (!/^p[a-z0-9-]+$/i.test(id)) return null; const f = fileFor(id); if (!fs.existsSync(f)) return null; const rec = JSON.parse(fs.readFileSync(f, "utf8")); return rec.id === id ? rec : null; };
  const save = rec => reviewAtomicWrite(fileFor(rec.id), JSON.stringify(rec, null, 2));
  const audit = (line) => reviewAudit(wsRoot, line);

  const handlers = {
    // GET /api/pending —— 列出待审
    async list(res) {
      const dir = pendingDir(wsRoot);
      let items = [];
      try {
        items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
          try { const r = load(f.slice(0, -5)); if (!r) return null; return { id: r.id, target: r.target, by: r.by, note: r.note, at: r.at, status: r.status || "pending", added: r.diff?.added, removed: r.diff?.removed }; } catch { return null; }
        }).filter(Boolean).filter((r) => ['pending', 'applying', 'needs_recovery'].includes(r.status));
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return json(res, 200, { ok: true, items, dir });
    },
    // GET /api/pending/:id —— 看单条（含 diff 全文与提议内容）
    async get(res, id) {
      const r = load(id);
      if (!r) return json(res, 404, { error: "not found" });
      return json(res, 200, { ok: true, item: r });
    },
    // POST /api/pending —— 提议一次改动 { target, content, by, note }（不写目标文件！）
    async create(res, body) {
      const target = String(body?.target || "").trim();
      const content = String(body?.content ?? "");
      if (!target) return json(res, 400, { error: "缺少 target（相对工作区的目标文件路径）" });
      let abs;
      try { abs = reviewPath(wsRoot, target); } catch (e) { return json(res, 400, { error: e.message }); }
      if (Buffer.byteLength(content) > 2_000_000 || (fs.existsSync(abs) && fs.statSync(abs).size > 2_000_000)) return json(res, 413, { error: '待审文件超过 2MB，请拆分改动' });
      let before = "";
      try { before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : ""; } catch { return json(res, 400, { error: '无法读取目标文件' }); }
      const rec = {
        id: rid(), at: new Date().toISOString(), target,
        by: String(body?.by || "agent"), note: String(body?.note || "").slice(0, 500),
        status: "pending", beforeExists: fs.existsSync(abs), beforeHash: hash(before),
        content, diff: unifiedDiff(before, content, target),
      };
      pendingDir(wsRoot);
      audit({ at: rec.at, kind: "pending-create", id: rec.id, target, by: rec.by, added: rec.diff.added, removed: rec.diff.removed });
      save(rec);
      return json(res, 200, { ok: true, id: rec.id, added: rec.diff.added, removed: rec.diff.removed, note: "改动已进待审区，尚未写盘；在工作台「改动验收」里接受后才生效" });
    },
    // POST /api/pending/:id/accept —— 接受：真正写盘（覆盖前留 .bak-apply）+ 审计
    async accept(res, id) {
      const rec = load(id);
      if (!rec) return json(res, 404, { error: "not found" });
      if (rec.status !== "pending") return json(res, 409, { error: "已处理过：" + rec.status });
      let abs;
      try { abs = reviewPath(wsRoot, rec.target); } catch (e) { return json(res, 400, { error: e.message }); }
      if (!rec.beforeHash) return json(res, 409, { error: '旧提议缺少原文件校验，请重新生成提议后验收' });
      const exists = fs.existsSync(abs);
      if (exists !== rec.beforeExists || (exists && (fs.statSync(abs).size > 2_000_000 || hash(fs.readFileSync(abs, 'utf8')) !== rec.beforeHash))) return json(res, 409, { error: '目标文件已变化，请重新生成提议，避免覆盖新内容' });
      const backup = exists ? rec.target + '.bak-apply-' + rec.id : null;
      try {
        audit({ at: new Date().toISOString(), kind: 'pending-accept-start', id, target: rec.target });
        rec.status = 'applying';
        save(rec);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (backup) fs.writeFileSync(reviewPath(wsRoot, backup), fs.readFileSync(abs), { flag: 'wx' });
        reviewAtomicWrite(abs, rec.content);
        rec.decidedAt = new Date().toISOString();
        audit({ at: rec.decidedAt, kind: "pending-accept", id: rec.id, target: rec.target, by: rec.by });
        rec.status = 'accepted';
        save(rec);
      } catch {
        rec.status = 'needs_recovery';
        try { save(rec); } catch { /* The persisted applying record still prevents replay. */ }
        return json(res, 500, { error: '验收写入未完整确认，请核对目标文件、备份和审计记录，不要重复应用', recoveryRequired: true });
      }
      return json(res, 200, { ok: true, applied: rec.target, backup });
    },
    // POST /api/pending/:id/reject —— 拒绝：什么都不写，仅记录
    async reject(res, id, body) {
      const rec = load(id);
      if (!rec) return json(res, 404, { error: "not found" });
      if (rec.status !== "pending") return json(res, 409, { error: "已处理过：" + rec.status });
      rec.status = "rejected"; rec.decidedAt = new Date().toISOString();
      rec.reason = String(body?.reason || "").slice(0, 300);
      audit({ at: rec.decidedAt, kind: "pending-reject", id: rec.id, target: rec.target, reason: rec.reason });
      save(rec);
      return json(res, 200, { ok: true, rejected: rec.target });
    },
  };
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (res, ...args) => {
    try { return await handler(res, ...args); }
    catch { return json(res, 500, { error: '待审记录读取或写入失败，请检查存储路径与权限' }); }
  }]));
}
