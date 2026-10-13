// engine/vector-store.mjs —— 手搓轻量向量存储（2026-10-13，Phase 1）
// 定位：个人场景 <5 万条，JSON 持久化 + 暴力余弦足够；量破阈值后切 sqlite-vec（升级路径已留）。
// 与多维表格的分工：这里只存向量本体 + 最小 payload；结构化元数据全部在 memories 表，
// 通过 vector_id 外键双向关联（表格行.vector_id → 这里.id）。
// ⚠️ 路径依赖运行时注入的 wsRoot——file() 每次调用时求值，禁止构造时固化（feedback 教训）。

import fs from "node:fs";
import path from "node:path";

let _wsRoot = null;
export function initVectorStore(wsRoot) { _wsRoot = wsRoot; }

function file() { return path.join(typeof _wsRoot === "function" ? _wsRoot() : _wsRoot, "memory", "vectors.json"); }

function load() {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return { vectors: {} }; }
}
function save(data) {
  const p = file();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, p);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 写入向量。返回 vector_id（未传则生成）。payload 放最小路由信息（如 memory_type），结构化数据在表格。 */
export function add(vectorId, vector, payload = {}) {
  if (!Array.isArray(vector) || !vector.length) throw new Error("向量必须是非空数组");
  const data = load();
  const id = vectorId || `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  data.vectors[id] = { v: vector.map(Number), payload, at: Date.now() };
  save(data);
  return id;
}

/** 余弦 topK 检索：返回 [{ id, score, payload }]，按 score 降序。 */
export function search(queryVector, topK = 8, { filter } = {}) {
  const data = load();
  const out = [];
  for (const [id, ent] of Object.entries(data.vectors)) {
    if (filter && !filter(ent.payload)) continue;
    out.push({ id, score: cosine(queryVector, ent.v), payload: ent.payload });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, Math.max(1, topK));
}

export function remove(vectorId) {
  const data = load();
  if (data.vectors[vectorId]) { delete data.vectors[vectorId]; save(data); return true; }
  return false;
}

export function stats() { const d = load(); return { count: Object.keys(d.vectors).length }; }
