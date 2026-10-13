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

let _db = null;
let _wsRoot = null;

export function initMemoryDb(wsRoot) {
  _wsRoot = wsRoot; // 注入函数或字符串均可，openDb 时求值
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
  return _db;
}

function validExpire(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("expire_at 必须是正的毫秒时间戳或留空");
  return Math.round(n);
}

/** 新增记忆。importance 缺省按来源给初值：manual 0.9 / skill 0.7 / auto 0.5 / feedback 0.6 */
export function addMemory({ user_id = "owner", memory_type, summary, raw_content = null, importance_score = null, expire_at = null, source = "manual", vector_id = null, last_confirmed_at = null } = {}) {
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
  db.prepare(`INSERT INTO memories (memory_id, user_id, memory_type, summary, raw_content, created_at, updated_at, importance_score, expire_at, source, vector_id, last_confirmed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, user_id, memory_type, String(summary).trim().slice(0, 2000), raw_content, now, now, imp, validExpire(expire_at), source, vector_id, confirmed);
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

export function getMemory(id, { touch = false } = {}) {
  const db = openDb();
  const it = db.prepare("SELECT * FROM memories WHERE memory_id = ?").get(String(id));
  if (it && touch) db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE memory_id = ?").run(Date.now(), String(id));
  return it || null;
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
  db.prepare("DELETE FROM memories WHERE memory_id = ?").run(String(id));
  return { ok: true, vector_id: it.vector_id || null };
}

/** 召回统计 + 过期归档（定时调用）：过期 active → archived；返回 { archived } */
export function sweepExpired() {
  const db = openDb();
  const r = db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE status = 'active' AND expire_at IS NOT NULL AND expire_at < ?")
    .run(Date.now(), Date.now());
  return { archived: r.changes };
}

import fs from "node:fs";
import path from "node:path";
