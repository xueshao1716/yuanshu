// engine/pending-api.mjs —— 「待审改动」（2026-09-20）
// 由来：openwriter（github.com/travsteward/openwriter, MIT）的核心设计是"agent 写字、人审阅"：
//       改动先以 diff 到达，接受/拒绝一次按键。我们把它落成元枢的机制：
//       agent（或我）改文件前，先把"目标文件 + 新内容 + diff"写进 工程/待审/<id>.json；
//       人在工作台「改动验收」里逐条 接受/拒绝；接受才真正写盘，并留审计。
import fs from "node:fs";
import path from "node:path";

const MAX_DIFF_CHARS = 20000;

function pendingDir(wsRoot) { return path.join(wsRoot, "工程", "待审"); }
function auditFile(wsRoot) { return path.join(wsRoot, "记忆", "授权记录.jsonl"); }

function rid() { return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function unifiedDiff(before, after, label = "") {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  const n = a.length, m = b.length;
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
  const load = (id) => { const f = path.join(pendingDir(wsRoot), id + ".json"); if (!fs.existsSync(f)) return null; return JSON.parse(fs.readFileSync(f, "utf8")); };
  const save = (rec) => { fs.mkdirSync(pendingDir(wsRoot), { recursive: true }); fs.writeFileSync(path.join(pendingDir(wsRoot), rec.id + ".json"), JSON.stringify(rec, null, 2), "utf8"); };
  const audit = (line) => { try { fs.appendFileSync(auditFile(wsRoot), JSON.stringify(line) + "\n", "utf8"); } catch {} };

  return {
    // GET /api/pending —— 列出待审
    async list(res) {
      const dir = pendingDir(wsRoot);
      let items = [];
      try {
        items = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => {
          try { const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return { id: r.id, target: r.target, by: r.by, note: r.note, at: r.at, status: r.status || "pending", added: r.diff?.added, removed: r.diff?.removed }; } catch { return null; }
        }).filter(Boolean).filter((r) => r.status === "pending");
      } catch {}
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
      const abs = path.join(wsRoot, target);
      let before = "";
      try { before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : ""; } catch {}
      const rec = {
        id: rid(), at: new Date().toISOString(), target,
        by: String(body?.by || "agent"), note: String(body?.note || "").slice(0, 500),
        status: "pending", beforeExists: fs.existsSync(abs),
        content, diff: unifiedDiff(before, content, target),
      };
      save(rec);
      audit({ at: rec.at, kind: "pending-create", id: rec.id, target, by: rec.by, added: rec.diff.added, removed: rec.diff.removed });
      return json(res, 200, { ok: true, id: rec.id, added: rec.diff.added, removed: rec.diff.removed, note: "改动已进待审区，尚未写盘；在工作台「改动验收」里接受后才生效" });
    },
    // POST /api/pending/:id/accept —— 接受：真正写盘（覆盖前留 .bak-apply）+ 审计
    async accept(res, id) {
      const rec = load(id);
      if (!rec) return json(res, 404, { error: "not found" });
      if (rec.status !== "pending") return json(res, 409, { error: "已处理过：" + rec.status });
      const abs = path.join(wsRoot, rec.target);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (fs.existsSync(abs)) fs.writeFileSync(abs + ".bak-apply", fs.readFileSync(abs));
        fs.writeFileSync(abs, rec.content, "utf8");
      } catch (e) { return json(res, 500, { error: String(e?.message || e).slice(0, 120) }); }
      rec.status = "accepted"; rec.decidedAt = new Date().toISOString();
      save(rec);
      audit({ at: rec.decidedAt, kind: "pending-accept", id: rec.id, target: rec.target, by: rec.by });
      return json(res, 200, { ok: true, applied: rec.target, backup: rec.target + ".bak-apply" });
    },
    // POST /api/pending/:id/reject —— 拒绝：什么都不写，仅记录
    async reject(res, id, body) {
      const rec = load(id);
      if (!rec) return json(res, 404, { error: "not found" });
      if (rec.status !== "pending") return json(res, 409, { error: "已处理过：" + rec.status });
      rec.status = "rejected"; rec.decidedAt = new Date().toISOString();
      rec.reason = String(body?.reason || "").slice(0, 300);
      save(rec);
      audit({ at: rec.decidedAt, kind: "pending-reject", id: rec.id, target: rec.target, reason: rec.reason });
      return json(res, 200, { ok: true, rejected: rec.target });
    },
  };
}
