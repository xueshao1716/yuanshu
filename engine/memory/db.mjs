// engine/memory-db.mjs —— 元枢记忆库存储层（Phase 1 地基，2026-10-13）
// 三类记忆架构中的「中长期记忆」主表：偏好 / 任务记录 / 事实。
// 存储：Node 25 内置 node:sqlite（零依赖，符合自研原则）；向量检索后续接
//（vector_id 字段是表格↔向量库的关联键，本层只存键不存向量）。
// ⚠️ db 路径依赖运行时注入的 WS_ROOT——惰性打开（首次使用时），不在模块顶层。

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const TYPES = new Set(["preference", "task_record", "fact"]);
const STATUSES = new Set(["active", "archived", "superseded"]);
const SOURCES = new Set(["manual", "auto", "skill", "feedback"]);

// ---------------------------------------------------------------------------
// 卡片层 + 归档层（2026-11-13）：两处设计取舍的存储契约
//   卡片层：事实一旦被提炼，原对话就只剩在日志里 → 检索得到结论却不知道出处。
//           所以每条记忆可带一份「触发它的那轮用户原话（+必要助手回应）」，
//           召回默认只给开头 200 字，全文按 id 取，避免把上下文撑爆。
//   归档层：遗忘默认归档不物理删除，所以需要 archived_at / archive_reason / restored_at。
// 旧库兼容：这些列都走 ensureMemorySchema 幂等 ALTER，老库第一次打开自动补齐。
// ---------------------------------------------------------------------------
export const CARD_MAX = 600;      // card_text 落库上限：留得住出处，又不至于把库撑大
export const CARD_PREVIEW = 200;  // 召回默认只给开头 200 字，全文按 id 取

const CARD_COLUMNS = Object.freeze({
  card_text: "TEXT",
  card_session: "TEXT",
  card_at: "INTEGER",
  card_msg_id: "TEXT",
  archived_at: "INTEGER",
  archive_reason: "TEXT",
  restored_at: "INTEGER",
});

// ---------------------------------------------------------------------------
// 向量层（2026-11-15）：**独立表** memory_vectors，不给 memories 加 BLOB 列。
//   ① 主表读路径全是 SELECT *（listMemories/getMemory/召回都走它）。2048 维 float32
//      = 8KB/行，塞进主表等于每次召回/列表多读 MB 级数据；而且 GET /api/memory 的
//      JSON 会把 Buffer 展开成 2048 个数字。
//   ② 换模型要并存新旧两版向量：主键 (memory_id, model) 天然支持"新版算完再删旧版"，
//      加列方案只能原地覆盖 → 重建期间半新半旧。
//   ③ "按模型统计缺向量" 用 GROUP BY 一次查完，不需要扫描主表大字段。
// 存储格式：L2 归一化后的 float32 原始字节（cos = 点积；~8KB/条，147 条约 1.2MB）。
// ---------------------------------------------------------------------------
export const VECTOR_STAGING_SUFFIX = "~staging"; // 重建期的影子模型名，成功后一次性改名切换

/** 幂等建向量表：旧库第一次打开自动补上（等价于补列，独立表方案）。 */
export function ensureVectorSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      memory_id TEXT NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (memory_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_memvec_model ON memory_vectors(model);
  `);
  return db;
}

/** 幂等补列：db 层与遗忘 CLI 共用同一份 schema，旧库（缺列）直接跑也不炸。 */
export function ensureMemorySchema(db) {
  const cols = new Set(db.prepare("PRAGMA table_info(memories)").all().map(c => c.name));
  for (const [name, type] of Object.entries(CARD_COLUMNS)) {
    if (!cols.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type};`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_mem_archived ON memories(archived_at) WHERE archived_at IS NOT NULL;");
  return db;
}

/** 截断保留头部（用户原话在前，超长只砍尾巴），末尾一个省略号。 */
export function clipCard(text, max = CARD_MAX) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** 卡片 = 触发这条记忆的那轮用户原话 + 必要的助手回应片段（用户原话优先，总长 ≤ CARD_MAX）。 */
export function buildCardText({ user = "", assistant = "", max = CARD_MAX } = {}) {
  const u = String(user || "").trim();
  const a = String(assistant || "").trim();
  const head = `【用户】${u}`;
  if (!a) return clipCard(head, max);
  const room = max - head.length - 5; // "\n【助手】" 占 5 字
  if (room <= 0) return clipCard(head, max);
  return clipCard(`${head}\n【助手】${a.slice(0, room)}`, max);
}

/** 召回用的卡片片段：头 200 字（含省略号），没有卡片就 null。 */
export function cardPreview(text, max = CARD_PREVIEW) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

let _db = null;
let _wsRoot = null;

export function initMemoryDb(wsRoot) {
  _wsRoot = wsRoot; // 注入函数或字符串均可，openDb 时求值
}

/** 记忆存储目录（{wsRoot}/memory）：召回权重等旁路配置与 db/vector 同口径，不各自拼路径。 */
export function memoryDir() {
  const root = typeof _wsRoot === "function" ? _wsRoot() : _wsRoot;
  if (!root) throw new Error("记忆库未初始化（initMemoryDb 未注入 wsRoot）");
  return path.join(root, "memory");
}

/** 关掉惰性连接并清空注入（测试换工作区/CLI 单次运行用；生产不调用）。 */
export function resetMemoryDb() {
  try { _db?.close(); } catch { }
  _db = null;
  _wsRoot = null;
}

function openDb() {
  if (_db) return _db;
  const root = typeof _wsRoot === "function" ? _wsRoot() : _wsRoot;
  const dir = path.join(root, "memory");
  fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(path.join(dir, "memory.db"));
  _db.exec("PRAGMA journal_mode = WAL;");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      memory_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'owner',
      memory_type TEXT NOT NULL CHECK (memory_type IN ('preference','task_record','fact')),
      summary TEXT NOT NULL,
      raw_content TEXT,
      vector_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      importance_score REAL NOT NULL DEFAULT 0.5,
      expire_at INTEGER,
      source TEXT NOT NULL DEFAULT 'manual',
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_mem_user_type ON memories(user_id, memory_type);
    CREATE INDEX IF NOT EXISTS idx_mem_vector ON memories(vector_id) WHERE vector_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mem_expire ON memories(expire_at) WHERE expire_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(importance_score DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status);
  `);
  // 信念保鲜字段（ToM 信念层 Phase 2，2026-10-13）：last_confirmed_at = 伙伴最近一次行为支持该条目。
  // 旧库兼容：无该列则 ALTER 补列，并初始化为创建时间（保守正确，不伪造确认）。
  const cols = _db.prepare("PRAGMA table_info(memories)").all().map(c => c.name);
  if (!cols.includes("last_confirmed_at")) {
    _db.exec("ALTER TABLE memories ADD COLUMN last_confirmed_at INTEGER;");
    _db.exec("UPDATE memories SET last_confirmed_at = created_at WHERE last_confirmed_at IS NULL;");
  }
  _db.exec("CREATE INDEX IF NOT EXISTS idx_mem_confirmed ON memories(last_confirmed_at) WHERE last_confirmed_at IS NOT NULL;");
  // 卡片层 + 归档层字段：旧库缺列就 ALTER 补（幂等；新库也会走这一遍，保持单一 schema 来源）
  ensureMemorySchema(_db);
  // 向量层（2026-11-15）：独立表，同样幂等；旧库打开即补。
  ensureVectorSchema(_db);
  // 回填脚本/服务器可能同时写（WAL 下多进程可写，但会 busy）——给 5s 退避而不是立刻抛。
  _db.exec("PRAGMA busy_timeout = 5000;");
  return _db;
}

function validExpire(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("expire_at 必须是正的毫秒时间戳或留空");
  return Math.round(n);
}

/** 新增记忆。importance 缺省按来源给初值：manual 0.9 / skill 0.7 / auto 0.5 / feedback 0.6 */
export function addMemory({ user_id = "owner", memory_type, summary, raw_content = null, importance_score = null, expire_at = null, source = "manual", vector_id = null, last_confirmed_at = null, card_text = null, card_session = null, card_at = null, card_msg_id = null } = {}) {
  if (!TYPES.has(memory_type)) throw new Error(`memory_type 必须是 ${[...TYPES].join("/")}`);
  if (!String(summary || "").trim()) throw new Error("summary 不能为空");
  if (!SOURCES.has(source)) throw new Error(`source 必须是 ${[...SOURCES].join("/")}`);
  const db = openDb();
  const id = randomUUID();
  const now = Date.now();
  const imp = importance_score === null || importance_score === undefined
    ? { manual: 0.9, skill: 0.7, feedback: 0.6, auto: 0.5 }[source] ?? 0.5
    : Math.max(0, Math.min(1, Number(importance_score)));
  // 信念保鲜：last_confirmed_at = 伙伴最近一次行为支持该条目的时间。未传则视为刚确认（创建=确认，保守正确）。
  const confirmed = last_confirmed_at ? (new Date(last_confirmed_at).getTime() || now) : now;
  // 卡片：只有给了原文才存；card_at 缺省=此刻（就是"这段话发生在什么时候"），msg_id 有就存。
  const card = clipCard(card_text);
  const rawCardAt = card_at instanceof Date ? card_at.getTime() : Number(card_at);
  const cardAt = card ? (Number.isFinite(rawCardAt) && rawCardAt > 0 ? Math.round(rawCardAt) : now) : null;
  const cardSession = card && card_session ? String(card_session).trim().slice(0, 160) || null : null;
  const cardMsg = card && card_msg_id ? String(card_msg_id).trim().slice(0, 160) || null : null;
  db.prepare(`INSERT INTO memories (memory_id, user_id, memory_type, summary, raw_content, created_at, updated_at, importance_score, expire_at, source, vector_id, last_confirmed_at,
                                   card_text, card_session, card_at, card_msg_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, user_id, memory_type, String(summary).trim().slice(0, 2000), raw_content, now, now, imp, validExpire(expire_at), source, vector_id, confirmed,
      card || null, cardSession, cardAt, cardMsg);
  return getMemory(id);
}

/**
 * 检索列表：字段过滤 + 命名视图 + 关键词 + 分页。
 * 命名视图（2026-10-13，排查 Agent 行为用）：
 *   recent    —— 最近记忆：按 updated_at 倒序（忽略重要性权重）
 *   important —— 高重要性记忆：importance_score >= 0.7，按分值倒序
 *   expired   —— 已过期/已归档：到期的与 archived 的，按到期倒序
 * 不传 view 走通用过滤（status 默认 active，按重要性+时间排序）。
 */
export function listMemories({ user_id = "owner", memory_type = "", status = "", q = "", view = "", limit = 50, offset = 0 } = {}) {
  const db = openDb();
  const where = ["user_id = ?"];
  const args = [user_id];
  let order = "importance_score DESC, updated_at DESC";
  if (view === "recent") {
    order = "updated_at DESC";
  } else if (view === "important") {
    where.push("importance_score >= 0.7", "status = 'active'");
    order = "importance_score DESC";
  } else if (view === "needs_review") {
    // ToM 信念层（2026-10-13）：信念保鲜审计。preference/fact 中确认时间缺失或 >30 天 → 待复核视图。
    where.push("memory_type IN ('preference','fact')", "status = 'active'", "(last_confirmed_at IS NULL OR last_confirmed_at < ?)");
    args.push(Date.now() - 30 * 86400000);
    order = "last_confirmed_at ASC";
  } else if (view === "expired") {
    where.push("(status = 'archived' OR (expire_at IS NOT NULL AND expire_at < ?))");
    args.push(Date.now());
    order = "COALESCE(expire_at, updated_at) DESC";
  } else if (status && status !== "all") {
    where.push("status = ?"); args.push(status);
  }
  if (memory_type && TYPES.has(memory_type)) { where.push("memory_type = ?"); args.push(memory_type); }
  if (q) { where.push("(summary LIKE ? OR raw_content LIKE ?)"); const like = `%${String(q).slice(0, 100)}%`; args.push(like, like); }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE ${where.join(" AND ")}`).get(...args).c;
  const items = db.prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, Math.max(1, Math.min(200, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
  return { total, items };
}

/** 向量回查：召回管线用——按 vector_id 集合拉取完整记忆行（user_id 隔离 + 只取 active）。 */
export function listByVectorIds(vectorIds, user_id = "owner") {
  const ids = [...new Set((Array.isArray(vectorIds) ? vectorIds : []).filter(Boolean))];
  if (!ids.length) return [];
  const db = openDb();
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM memories WHERE vector_id IN (${ph}) AND user_id = ? AND status = 'active'`)
    .all(...ids, user_id);
}

// ---------------------------------------------------------------------------
// 向量层 CRUD（2026-11-15）：BLOB = L2 归一化 float32，cos 相似度即点积。
// 写入统一走 setMemoryVector 归一化，避免"有的存原向量、有的存归一化"导致分数漂移。
// ---------------------------------------------------------------------------

/** 校验 + L2 归一化。返回 Float32Array；0 模长/非有限值直接抛，让调用方降级。 */
export function normalizeVector(vec) {
  const arr = ArrayBuffer.isView(vec) || Array.isArray(vec) ? Array.from(vec, Number) : [];
  if (!arr.length) throw new Error("向量必须是非空数组");
  if (arr.length > 8192) throw new Error(`向量维度异常：${arr.length}`);
  let sq = 0;
  for (const v of arr) {
    if (!Number.isFinite(v)) throw new Error("向量含非有限数值");
    sq += v * v;
  }
  if (!sq) throw new Error("向量模长为 0");
  const inv = 1 / Math.sqrt(sq);
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) out[i] = arr[i] * inv;
  return out;
}

function decodeVectorRow(row) {
  const bytes = row.vec instanceof Uint8Array ? row.vec : Uint8Array.from(row.vec || []);
  // Buffer 可能来自 Node 的池化 ArrayBuffer，必须按 byteOffset 精确切，否则会读到隔壁数据。
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

/** 写一条向量（同 model 覆盖，旧 model 保留——换模型重建时新旧并存，切换前不动旧版）。 */
export function setMemoryVector(memoryId, { model, vec, at = Date.now() } = {}) {
  const m = String(model || "").trim();
  if (!m) throw new Error("embed_model 不能为空");
  const arr = normalizeVector(vec);
  const db = openDb();
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  const ts = Number.isFinite(Number(at)) ? Math.round(Number(at)) : Date.now();
  db.prepare(`INSERT INTO memory_vectors (memory_id, model, dim, vec, at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(memory_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, at = excluded.at`)
    .run(String(memoryId), m, arr.length, buf, ts);
  return { memory_id: String(memoryId), model: m, dim: arr.length, at: ts };
}

export function getMemoryVector(memoryId, model) {
  const row = openDb().prepare("SELECT memory_id, model, dim, vec, at FROM memory_vectors WHERE memory_id = ? AND model = ?")
    .get(String(memoryId), String(model || ""));
  if (!row) return null;
  return { memory_id: row.memory_id, model: row.model, dim: row.dim, vec: decodeVectorRow(row), at: row.at };
}

/** 批量取向量（召回用）：返回 Map<memory_id, Float32Array>。分批拼 IN，避免超过 SQLite 变量上限。 */
export function listMemoryVectors(memoryIds, model, { chunk = 400 } = {}) {
  const m = String(model || "").trim();
  const ids = [...new Set((Array.isArray(memoryIds) ? memoryIds : []).filter(Boolean).map(String))];
  const out = new Map();
  if (!m || !ids.length) return out;
  const db = openDb();
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const ph = part.map(() => "?").join(",");
    const rows = db.prepare(`SELECT memory_id, vec FROM memory_vectors WHERE model = ? AND memory_id IN (${ph})`)
      .all(m, ...part);
    for (const row of rows) out.set(row.memory_id, decodeVectorRow(row));
  }
  return out;
}

/** 已有向量的 memory_id 集合（回填脚本用：只取 id，不搬 8KB BLOB）。 */
export function listMemoryIdsWithVector(model) {
  const m = String(model || "").trim();
  if (!m) return new Set();
  return new Set(openDb().prepare("SELECT memory_id FROM memory_vectors WHERE model = ?").all(m).map(r => r.memory_id));
}

/** 脚本/审计用：不受分页上限（listMemories 最多 200）限制地取行——只在离线工具里用，别进请求路径。 */
export function listAllMemoryRows({ status = "", user_id = "owner" } = {}) {
  const db = openDb();
  const where = ["user_id = ?"];
  const args = [user_id];
  if (status && status !== "all") { where.push("status = ?"); args.push(status); }
  return db.prepare(`SELECT * FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at ASC`).all(...args);
}

/** 向量覆盖率统计：总行数 / 已有向量 / 缺向量 + 按模型分布（回填脚本与 debug 接口共用）。 */
export function memoryVectorStats({ model = "" } = {}) {
  const db = openDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM memories").get().c;
  const models = db.prepare("SELECT model, COUNT(*) AS count, MIN(dim) AS min_dim, MAX(dim) AS max_dim, MAX(at) AS last_at FROM memory_vectors GROUP BY model ORDER BY model")
    .all().map(r => ({ model: r.model, count: r.count, dim: r.max_dim ?? null, minDim: r.min_dim ?? null, lastAt: r.last_at ?? null }));
  const m = String(model || "").trim();
  let withVec = 0;
  let missing = total;
  if (m) {
    withVec = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors v JOIN memories x ON x.memory_id = v.memory_id WHERE v.model = ?").get(m).c;
    missing = Math.max(0, total - withVec);
  }
  const orphan = db.prepare("SELECT COUNT(*) AS c FROM memory_vectors v LEFT JOIN memories x ON x.memory_id = v.memory_id WHERE x.memory_id IS NULL").get().c;
  return { total, withVec, missing, model: m, models, orphan };
}

/** 删掉某个模型的全部向量（重建失败清理 staging / 换模型后清理旧版）。 */
export function deleteMemoryVectorsByModel(model) {
  const m = String(model || "").trim();
  if (!m) return { deleted: 0 };
  const r = openDb().prepare("DELETE FROM memory_vectors WHERE model = ?").run(m);
  return { deleted: r.changes };
}

/**
 * 重建切换：把 from（staging 模型名）整体改名为 to。
 * 先删 to 的旧行再改名，同一事务内完成——调用方要么看到旧模型全量、要么看到新模型全量。
 * dropOthers=true 时顺带清掉别的模型（换模型重建后旧模型向量不再需要）。
 */
export function switchMemoryVectors({ from, to, dropOthers = false } = {}) {
  const f = String(from || "").trim();
  const t = String(to || "").trim();
  if (!f || !t || f === t) throw new Error("switchMemoryVectors 需要 from/to 且不能相同");
  const db = openDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const replaced = db.prepare("DELETE FROM memory_vectors WHERE model = ?").run(t).changes;
    const moved = db.prepare("UPDATE memory_vectors SET model = ? WHERE model = ?").run(t, f).changes;
    const dropped = dropOthers ? db.prepare("DELETE FROM memory_vectors WHERE model <> ?").run(t).changes : 0;
    db.exec("COMMIT");
    return { moved, replaced, dropped };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { }
    throw e;
  }
}

export function getMemory(id, { touch = false } = {}) {
  const db = openDb();
  const it = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(String(id));
  if (it && touch) db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE memory_id = ?").run(Date.now(), String(id));
  return it || null;
}

/** 按 id 取完整卡片（召回默认只给 200 字片段，全文走这里，避免上下文被卡片撑爆）。 */
export function getMemoryCard(id) {
  return openDb().prepare(
    "SELECT memory_id, summary, status, card_text, card_session, card_at, card_msg_id FROM memories WHERE memory_id = ?",
  ).get(String(id)) || null;
}

/** 恢复归档：archived → active，并记 restored_at（归档历史不清空，仍可审计）。 */
export function restoreMemory(id, { at = Date.now() } = {}) {
  const db = openDb();
  const it = db.prepare("SELECT memory_id, status FROM memories WHERE memory_id = ?").get(String(id));
  if (!it) return { ok: false, error: "not_found" };
  if (it.status !== "archived") return { ok: false, error: "not_archived", status: it.status };
  const now = Date.now();
  const t = Number(at);
  db.prepare("UPDATE memories SET status = 'active', restored_at = ?, updated_at = ? WHERE memory_id = ?")
    .run(Number.isFinite(t) && t > 0 ? Math.round(t) : now, now, String(id));
  return { ok: true, item: getMemory(String(id)) };
}

/** 编辑。只允许改这些字段（memory_id/user_id/vector_id/created_at 不可变）。 */
export function updateMemory(id, patch = {}) {
  const db = openDb();
  const allowed = {};
  if (patch.summary !== undefined) {
    const s = String(patch.summary).trim().slice(0, 2000);
    if (!s) throw new Error("summary 不能为空");
    allowed.summary = s;
  }
  if (patch.memory_type !== undefined) {
    if (!TYPES.has(patch.memory_type)) throw new Error("memory_type 非法");
    allowed.memory_type = patch.memory_type;
  }
  if (patch.importance_score !== undefined) allowed.importance_score = Math.max(0, Math.min(1, Number(patch.importance_score) || 0));
  if (patch.expire_at !== undefined) allowed.expire_at = validExpire(patch.expire_at);
  if (patch.status !== undefined) {
    if (!STATUSES.has(patch.status)) throw new Error("status 非法");
    allowed.status = patch.status;
  }
  if (patch.raw_content !== undefined) allowed.raw_content = patch.raw_content;
  if (patch.vector_id !== undefined) allowed.vector_id = patch.vector_id; // 绑定向量（写入流程第 2→3 步的桥）
  if (patch.last_confirmed_at !== undefined) {
    const t = patch.last_confirmed_at ? new Date(patch.last_confirmed_at).getTime() : Date.now();
    if (Number.isNaN(t)) throw new Error("last_confirmed_at 非法时间");
    allowed.last_confirmed_at = t; // 信念保鲜：确认动作只由伙伴复核触发（confirmMemory / PATCH）
  }
  const keys = Object.keys(allowed);
  if (!keys.length) throw new Error("没有可更新字段");
  db.prepare(`UPDATE memories SET ${keys.map(k => `${k} = ?`).join(", ")}, updated_at = ? WHERE memory_id = ?`)
    .run(...keys.map(k => allowed[k]), Date.now(), String(id));
  return getMemory(String(id));
}

/** 确认信念（ToM Phase 2）：伙伴复核过这条信念仍是现行意愿。只推确认时间，不碰其他字段。 */
export function confirmMemory(id) {
  const db = openDb();
  const it = db.prepare("SELECT memory_id FROM memories WHERE memory_id = ?").get(String(id));
  if (!it) return null;
  db.prepare("UPDATE memories SET last_confirmed_at = ?, updated_at = ? WHERE memory_id = ?")
    .run(Date.now(), Date.now(), String(id));
  return getMemory(String(id));
}

/** 删除（硬删）。若已挂向量，调用方需同步删向量（本层返回 vector_id 供上游处理）。 */
export function deleteMemory(id) {
  const db = openDb();
  const it = db.prepare("SELECT vector_id FROM memories WHERE memory_id = ?").get(String(id));
  if (!it) return { ok: false, error: "not_found" };
  // 向量层（2026-11-15）：BLOB 表随主行一起删，主表没有 ON DELETE CASCADE 可依赖。
  db.prepare("DELETE FROM memory_vectors WHERE memory_id = ?").run(String(id));
  db.prepare("DELETE FROM memories WHERE memory_id = ?").run(String(id));
  return { ok: true, vector_id: it.vector_id || null };
}

/** 召回统计 + 过期归档（定时调用）：过期 active → archived；返回 { archived }。
 *  归档优先：顺手记 archived_at / archive_reason，跟遗忘 CLI 的归档口径保持一致。 */
export function sweepExpired() {
  const db = openDb();
  const now = Date.now();
  const r = db.prepare("UPDATE memories SET status = 'archived', archived_at = COALESCE(archived_at, ?), archive_reason = COALESCE(archive_reason, '过期自动归档'), updated_at = ? WHERE status = 'active' AND expire_at IS NOT NULL AND expire_at < ?")
    .run(now, now, now);
  return { archived: r.changes };
}

import fs from "node:fs";
import path from "node:path";
