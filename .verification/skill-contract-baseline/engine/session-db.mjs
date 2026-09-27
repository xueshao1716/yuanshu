// engine/session-db.mjs —— 会话数据库（08-29 真落地：编号/健康度/标签/置顶）
// 索引持久化 {agentDir}/session-db.json；会话文件本体不动，只加元数据层
// 健康：ok <1MB ｜ large 1-5MB ｜ oversized >5MB（对齐 session-sanitize 截断阈值）
import fs from "node:fs";
import path from "node:path";
import { json } from "./http-utils.mjs";
import { sanitizeSessionFile } from "./session-sanitize.mjs";
import { getSessionList, invalidateSessionCache, compareSessionTimes } from "./session-files.mjs";
import { runSessionSweep } from "./session-groups.mjs";

let _agentDir = "", _cwd = "";
let _deleteSession = async () => {};
let _db = null; // { seqMap:{id:seq}, tags:{id:[]}, pinned:{id:true}, messageCount:{id:n}, lastRebuild }

function dbFile() { return path.join(_agentDir, "session-db.json"); }
function loadDb() {
  if (_db) return _db;
  try { _db = JSON.parse(fs.readFileSync(dbFile(), "utf8")); } catch { _db = {}; }
  _db.seqMap ||= {}; _db.tags ||= {}; _db.pinned ||= {}; _db.messageCount ||= {};
  return _db;
}
function saveDb() { try { fs.writeFileSync(dbFile(), JSON.stringify(_db, null, 1)); } catch {} }

function nextSeq(db = loadDb()) {
  const values = Object.values(db.seqMap || {}).map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0);
  return (values.length ? Math.max(...values) : 0) + 1;
}

function validSeq(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 为新会话和历史上未建索引的会话自动补发稳定编号。已有编号永不因排序变化而重写；
// 首次补号按创建时间从旧到新，保证历史会话编号可读且新会话继续单调递增。
export function ensureSessionSequences(sessions = getSessionList()) {
  const db = loadDb();
  let changed = false;
  // 旧版本偶尔把编号以字符串写入 JSON，加载时统一成数字，避免前端排序发生隐式类型转换。
  for (const [id, value] of Object.entries(db.seqMap || {})) {
    const normalized = validSeq(value);
    if (normalized === null) continue;
    if (value !== normalized) { db.seqMap[id] = normalized; changed = true; }
  }
  const missing = (sessions || [])
    .filter(session => validSeq(db.seqMap[session.id]) === null)
    .sort((a, b) => compareSessionTimes({ ...a, updatedAt: a.createdAt }, { ...b, updatedAt: b.createdAt }));
  // compareSessionTimes 默认最新在前；补号需要旧的先拿到更小编号。
  missing.reverse();
  for (const session of missing) {
    db.seqMap[session.id] = nextSeq(db);
    changed = true;
  }
  if (changed) saveDb();
  return db;
}

// 创建会话后立即分配编号；列表读取时仍会调用 ensureSessionSequences 做一次兜底补号。
export function ensureSessionSequence(sessionOrId) {
  const id = typeof sessionOrId === "string" ? sessionOrId : sessionOrId?.id;
  if (!id) return null;
  const db = loadDb();
  const current = validSeq(db.seqMap[id]);
  if (current !== null) {
    if (db.seqMap[id] !== current) { db.seqMap[id] = current; saveDb(); }
    return current;
  }
  const seq = nextSeq(db);
  db.seqMap[id] = seq;
  saveDb();
  return seq;
}

function healthOf(bytes) { return bytes > 5 * 1024 * 1024 ? "oversized" : bytes > 1024 * 1024 ? "large" : "ok"; }

function countLines(file) {
  try {
    let n = 0;
    const buf = fs.readFileSync(file);
    for (const b of buf) if (b === 0x0a) n++;
    return n;
  } catch { return 0; }
}

export function initSessionDb({ agentDir = "", cwd = "", deleteSession = null } = {}) {
  _agentDir = agentDir;
  _cwd = cwd;
  if (typeof deleteSession === "function") _deleteSession = deleteSession;
}

// GET /api/sessions/db/list —— 全量（索引优先，实时状态合并）
export function handleDbList(res) {
  const db = loadDb();
  const sessions = getSessionList();
  // 读取列表即自动补号，避免用户必须先点击“重建索引”。
  ensureSessionSequences(sessions);
  const rows = [];
  for (const s of sessions) {
    let size = 0, mtimeIso = null;
    try { const st = fs.statSync(s.file); size = st.size; mtimeIso = new Date(st.mtimeMs).toISOString(); } catch {}
    rows.push({
      id: s.id, name: s.name || "(未命名)", cwd: s.cwd || "",
      createdAt: s.createdAt || null, updatedAt: s.updatedAt || null,
      sizeBytes: size, health: healthOf(size),
      messageCount: db.messageCount[s.id] ?? null, // rebuild 时算并持久化，这里读缓存（2026-09-04 修“永远—”）
      mtime: mtimeIso, // statSync 同次顺手取（此前遗漏永远 —）
      seq: db.seqMap[s.id] || null,
      pinned: !!db.pinned[s.id], tags: db.tags[s.id] || [],
      group: s.group || "workspace",
    });
  }
  rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || compareSessionTimes(a, b)); // 置顶优先，其余严格按更新时间
  json(res, 200, { sessions: rows });
}

// POST /api/sessions/db/rebuild —— 重扫：新会话补编号，消失的清编号，行数统计
export function handleDbRebuild(res) {
  const db = loadDb();
  const live = new Set();
  let added = 0;
  const sessions = getSessionList();
  const before = new Set(Object.keys(db.seqMap || {}).filter(id => validSeq(db.seqMap[id]) !== null));
  ensureSessionSequences(sessions);
  for (const s of sessions) {
    live.add(s.id);
    if (!before.has(s.id)) added++;
    let size = 0;
    try { const st = fs.statSync(s.file); size = st.size; } catch {}
    s.sizeBytes = size; s.health = healthOf(size); s.messageCount = countLines(s.file);
    db.messageCount[s.id] = s.messageCount; // 持久化（此前算完即丢，下次 list 全变 —，2026-09-04 修）
  }
  for (const id of Object.keys(db.seqMap)) if (!live.has(id)) delete db.seqMap[id];
  db.lastRebuild = new Date().toISOString();
  saveDb();
  const rows = sessions.map(s => ({ id: s.id, seq: db.seqMap[s.id], sizeBytes: s.sizeBytes, health: s.health, messageCount: s.messageCount }));
  const health = { ok: 0, large: 0, oversized: 0 };
  for (const r of rows) health[r.health] = (health[r.health] || 0) + 1;
  const totalBytes = rows.reduce((a, r) => a + (r.sizeBytes || 0), 0);
  json(res, 200, { ok: true, total: rows.length, added, health, totalMB: +(totalBytes / 1048576).toFixed(1), sessions: rows, lastRebuild: db.lastRebuild });
}

// POST /api/sessions/db/sanitize {ids:[...]} —— 批量截断超大字段
export async function handleDbSanitize(res, body) {
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, 200) : [];
  if (!ids.length) return json(res, 400, { error: "缺 ids" });
  const all = getSessionList();
  const results = [];
  for (const id of ids) {
    const s = all.find(x => x.id === id);
    if (!s?.file) { results.push({ id, ok: false, reason: "not found" }); continue; }
    const before = (() => { try { return fs.statSync(s.file).size; } catch { return 0; } })();
    const r = sanitizeSessionFile(s.file);
    const after = (() => { try { return fs.statSync(s.file).size; } catch { return 0; } })();
    results.push({ id, ok: true, linesPatched: r.truncated, bytesSaved: Math.max(0, before - after) });
  }
  json(res, 200, { ok: true, results });
}

// PATCH /api/sessions/db/meta {id, pinned?, tags?}
export function handleDbMeta(res, body) {
  const id = String(body?.id || "");
  if (!id) return json(res, 400, { error: "缺 id" });
  const db = loadDb();
  if (!db.seqMap[id]) {
    const exists = getSessionList().some(s => s.id === id);
    if (!exists) return json(res, 404, { error: "会话不存在" });
    db.seqMap[id] = nextSeq();
  }
  if (typeof body.pinned === "boolean") { if (body.pinned) db.pinned[id] = true; else delete db.pinned[id]; }
  if (Array.isArray(body.tags)) db.tags[id] = body.tags.map(t => String(t).slice(0, 20)).slice(0, 8);
  saveDb();
  json(res, 200, { ok: true, id, seq: db.seqMap[id], pinned: !!db.pinned[id], tags: db.tags[id] || [] });
}

// POST /api/sessions/db/sweep {dryRun?, minAgeMs?} —— 清空壳/真测残渣/工坊一枪，置顶与外部联系保留
export async function sweepSessionsNow({ dryRun = false, minAgeMs = 6 * 3600 * 1000 } = {}) {
  const db = loadDb();
  const pinnedIds = new Set(Object.keys(db.pinned || {}).filter(id => db.pinned[id]));
  const result = await runSessionSweep({
    sessions: getSessionList(),
    pinnedIds,
    now: Date.now(),
    minAgeMs,
    dryRun,
    deleteSession: _deleteSession,
  });
  if (!result.dryRun) invalidateSessionCache();
  return result;
}

export async function handleDbSweep(res, body = {}) {
  const minAgeMs = Number.isFinite(Number(body?.minAgeMs)) ? Number(body.minAgeMs) : 6 * 3600 * 1000;
  json(res, 200, await sweepSessionsNow({ dryRun: !!body?.dryRun, minAgeMs }));
}

// GET /api/sessions/db/stats —— 概览
export function handleDbStats(res) {
  const db = loadDb();
  const all = getSessionList();
  const health = { ok: 0, large: 0, oversized: 0 };
  let totalBytes = 0;
  for (const s of all) {
    let size = 0;
    try { size = fs.statSync(s.file).size; } catch {}
    totalBytes += size;
    health[healthOf(size)]++;
  }
  json(res, 200, { total: all.length, totalMB: +(totalBytes / 1048576).toFixed(1), health, lastRebuild: db.lastRebuild || null });
}
