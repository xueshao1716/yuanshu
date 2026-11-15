// ===== engine/memory/recall.mjs —— 召回（2026-11-06；2026-11-15 混合检索）=====
//
// 长期记忆不能"全量塞进提示词"（那正是 token 浪费的主因之一）。
// 这里按 相关性 × 时效 × 重要性 打分，只取 top-N，并且限量字数。
//
// 2026-11-15 接入向量（embedding.mjs 之前只写了没接）：字面匹配 → 混合检索。
//   有查询向量 且 该行有同模型向量：score = kw(0.40) + vec(0.40) + imp(0.15) + fresh(0.05)
//   否则（无向量 / embedding 不可用 / enabled:false）：**完全退回**旧公式
//     score = rel(0.55) + imp(0.30) + fresh(0.15)
// 设计红线是 fail-open：接向量只能让召回变好，绝不能让它变差。
//
// 配置 {wsRoot}/memory/recall-weights.json（缺省/坏文件都用默认值，改文件无需重启，按 mtime 热加载）：
//   { "enabled": true, "weights": { "kw": 0.40, "vec": 0.40, "imp": 0.15, "fresh": 0.05 },
//     "vecThreshold": 0.45 }
//   enabled:false 一键回退旧行为（连 embedding 都不调用）。
import fs from "node:fs";
import path from "node:path";
import {
  listMemories, getMemory, cardPreview, memoryDir,
  listMemoryVectors, memoryVectorStats, VECTOR_STAGING_SUFFIX,
} from "./db.mjs";
import { embed as defaultEmbed, configInfo as embeddingConfigInfo } from "../embedding.mjs";

const DAY = 86400000;

// 旧公式权重（不动，回退时逐位一致）
export const LEGACY_WEIGHTS = Object.freeze({ kw: 0.55, imp: 0.30, fresh: 0.15 });
// 混合公式默认权重：和为 1，和旧公式同量纲，旧/新分数可直接对照
export const DEFAULT_WEIGHTS = Object.freeze({ kw: 0.40, vec: 0.40, imp: 0.15, fresh: 0.05 });
// 余弦阈值：低于它不加分（见 recall-weights 说明与 README/报告里的分布数据）
export const DEFAULT_VEC_THRESHOLD = 0.45;
// 召回是请求路径：embedding 必须给硬上限（embedding.mjs 默认 20s，会把一轮对话拖死）。
// 实测 GLM embedding-3 单次 0.6~5s（波动大），超时按失败处理 → 整体退回旧公式。
export const DEFAULT_EMBED_TIMEOUT_MS = 5000;

// 注入的 embedding 实现。默认 null = 不启用向量（单测/脚本必须显式注入，绝不偷偷发网络请求）。
let _embed = null;
export function initRecallEmbedding(fn) { _embed = typeof fn === "function" ? fn : null; }

// ---------------------------------------------------------------------------
// 字面相关度（旧公式的 kw 项，保持原实现）
// ---------------------------------------------------------------------------
const tokensOf = (s) => {
  const chunks = String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(x => x.length > 1);
  const out = [];
  for (const c of chunks) {
    out.push(c);
    // 中文没有空格，整句会被当一个词：补字符二元组，否则相关性恒为 0
    if (/\p{Script=Han}/u.test(c) && c.length > 2) {
      for (let i = 0; i + 2 <= c.length; i += 1) out.push(c.slice(i, i + 2));
    }
  }
  return out;
};

/** 与查询的字面相关度（0~1）。没有查询词时按 0 处理，只靠时效与重要性。 */
export function relevance(query, summary) {
  const q = new Set(tokensOf(query));
  if (!q.size) return 0;
  const s = new Set(tokensOf(summary));
  let hit = 0;
  for (const t of q) if (s.has(t)) hit += 1;
  return hit / q.size;
}

function partsOf(row, query, now) {
  const rel = relevance(query, row.summary);
  const imp = Math.max(0, Math.min(1, Number(row.importance_score ?? 0.5)));
  const last = Number(row.last_accessed_at || row.updated_at || row.created_at || now);
  const ageDays = Math.max(0, (now - last) / DAY);
  const fresh = Math.max(0, 1 - ageDays / 180); // 半年线性衰减
  return { rel, imp, fresh };
}

/** 旧公式（2026-11-06 起在用）：相关性 0.55 + 重要性 0.3 + 时效 0.15。 */
export function legacyScore(row, query, now = Date.now()) {
  const { rel, imp, fresh } = partsOf(row, query, now);
  return rel * LEGACY_WEIGHTS.kw + imp * LEGACY_WEIGHTS.imp + fresh * LEGACY_WEIGHTS.fresh;
}

// ---------------------------------------------------------------------------
// 余弦：两边都按 L2 归一化后点积（向量库里存的已经是归一化 float32，这里再算一次
// 是为了让"手算样例/外部来源向量"也正确；2048 维 × 148 行只有 ~1M 次乘，不是瓶颈）。
// ---------------------------------------------------------------------------
export function cosine(a, b) {
  if (!a || !b || !a.length || !b.length) return 0;
  if (a.length !== b.length) return 0; // 维度不一致（模型混装/脏数据）直接当无关
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * 详细打分（内部/调试用）。带 ctx 且 queryVec、rowVec 都有才走混合分，否则旧公式。
 * @returns {{score:number, parts:object, mode:"hybrid"|"keyword", cos:number|null}}
 *   parts 是**加权贡献**（hybrid 时四项相加=score；keyword 时 vec=null）。
 */
export function scoreDetailed(row, query, now = Date.now(), { queryVec = null, rowVec = null, weights = DEFAULT_WEIGHTS, vecThreshold = DEFAULT_VEC_THRESHOLD } = {}) {
  const { rel, imp, fresh } = partsOf(row, query, now);
  if (!queryVec || !rowVec) {
    return {
      score: legacyScore(row, query, now),
      parts: { kw: rel * LEGACY_WEIGHTS.kw, vec: null, imp: imp * LEGACY_WEIGHTS.imp, fresh: fresh * LEGACY_WEIGHTS.fresh },
      mode: "keyword",
      cos: null,
    };
  }
  const cos = cosine(queryVec, rowVec);
  // 阈值以下：vec 记 0（不加分也不倒扣——语义相反不该比"无关"更差），
  // 该行仍可凭关键词/重要性/时效进来，但拿不到 vec 那 0.40。
  //
  // vec 采用 max(0, cos) 而不是 (cos+1)/2：
  //   ① (cos+1)/2 会把"无关"（cos≈0）映成 0.5，vec 项恒有 0.2 打底——那 0.35~0.5 的阈值
  //      在映射后失去意义，也等于给所有记忆统一加分、稀释了关键词与重要性；
  //   ② 本库 148 条实测：无关/弱相关记忆的 cos 中位数≈0.39，映射后全挤在 0.69 附近，区分度被压平；
  //   ③ cos<0（语义相反）不该比 cos=0（无关）更差，clamp 到 0 由其余三项兜底。
  const vec = cos >= vecThreshold ? Math.max(0, cos) : 0;
  const parts = {
    kw: rel * weights.kw,
    vec: vec * weights.vec,
    imp: imp * weights.imp,
    fresh: fresh * weights.fresh,
  };
  return { score: parts.kw + parts.vec + parts.imp + parts.fresh, parts, mode: "hybrid", cos };
}

/** 兼容旧签名：scoreMemory(row, query, now) 与 2026-11-06 的实现逐位一致（无 ctx 时不碰向量）。 */
export function scoreMemory(row, query, now = Date.now(), ctx = {}) {
  return scoreDetailed(row, query, now, ctx).score;
}

// ---------------------------------------------------------------------------
// 配置热加载
// ---------------------------------------------------------------------------
let _cfgCache = { key: "", value: null };

export function recallWeightsFile() {
  try { return path.join(memoryDir(), "recall-weights.json"); } catch { return ""; }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** 读权重配置。缺文件/坏 JSON/字段非法一律回默认；按 (mtime,size) 缓存，改文件即生效。 */
export function loadRecallConfig({ force = false } = {}) {
  const file = recallWeightsFile();
  let key = "missing";
  try { const st = fs.statSync(file); key = `${st.mtimeMs}:${st.size}`; } catch { }
  if (!force && _cfgCache.key === key && _cfgCache.value) return _cfgCache.value;

  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { }
  const rawWeights = raw && typeof raw.weights === "object" && raw.weights ? raw.weights : {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  let weights = {
    kw: num(rawWeights.kw, DEFAULT_WEIGHTS.kw),
    vec: num(rawWeights.vec, DEFAULT_WEIGHTS.vec),
    imp: num(rawWeights.imp, DEFAULT_WEIGHTS.imp),
    fresh: num(rawWeights.fresh, DEFAULT_WEIGHTS.fresh),
  };
  const sum = weights.kw + weights.vec + weights.imp + weights.fresh;
  if (!(sum > 0)) weights = { ...DEFAULT_WEIGHTS };
  else if (Math.abs(sum - 1) > 1e-9) weights = { kw: weights.kw / sum, vec: weights.vec / sum, imp: weights.imp / sum, fresh: weights.fresh / sum };
  const value = {
    enabled: raw?.enabled !== false, // 缺省开启；显式 false 才回退
    weights,
    vecThreshold: clamp(num(raw?.vecThreshold, DEFAULT_VEC_THRESHOLD), 0, 1),
    // 可选：embedding 超时（毫秒，500~20000）。请求路径的保护上限，别设太大。
    embedTimeoutMs: clamp(num(raw?.embedTimeoutMs, DEFAULT_EMBED_TIMEOUT_MS), 500, 20000),
    source: raw ? "file" : "default",
    file,
  };
  _cfgCache = { key, value };
  return value;
}

export function resetRecallConfigCache() { _cfgCache = { key: "", value: null }; }

/** 当前配置对应的向量模型：优先显式传参 → embedding 配置 → 库里唯一存在的模型。 */
export function resolveEmbedModel(explicit = "") {
  if (explicit) return String(explicit);
  try {
    const info = embeddingConfigInfo();
    if (info?.configured && info.model) return String(info.model);
  } catch { }
  try {
    const st = memoryVectorStats();
    const real = st.models.filter(m => !String(m.model).endsWith(VECTOR_STAGING_SUFFIX));
    if (real.length === 1) return String(real[0].model);
  } catch { }
  return "";
}

// ---------------------------------------------------------------------------
// 召回
// ---------------------------------------------------------------------------
const round3 = (n) => Number(Number(n).toFixed(3));
function roundParts(parts) {
  const out = {};
  for (const [k, v] of Object.entries(parts)) out[k] = v === null || v === undefined ? null : round3(v);
  return out;
}

/** 从排名结果里按 limit/maxChars 取条目（新旧两条排序共用同一取舍逻辑，对照才公平）。 */
function pickTop(ranked, { limit, maxChars }) {
  const picked = [];
  let chars = 0;
  for (const entry of ranked) {
    if (picked.length >= limit) break;
    const text = String(entry.row.summary || "");
    if (!text) continue;
    if (chars + text.length > maxChars && picked.length > 0) continue;
    picked.push({ ...entry, text });
    chars += text.length;
  }
  return { picked, chars };
}

function itemOf(entry, debug) {
  const { row, text, score, parts, mode, cos } = entry;
  const base = {
    id: row.memory_id, summary: text, type: row.memory_type, score: round3(score),
    card: cardPreview(row.card_text), card_at: row.card_at || null,
  };
  // 调试字段只走内部/调试接口，提示词仍只用 summary（recallPrompt 不读这些）
  if (debug) {
    base.scoreParts = roundParts(parts || {});
    base.mode = mode;
    base.cos = cos === null || cos === undefined ? null : round3(cos);
  }
  return base;
}

/**
 * 召回 top-N。
 * @param {object} opts
 * @param {string} opts.query 当前用户这句话（用于相关性 + 向量）
 * @param {number} opts.limit 条数（默认 8）
 * @param {number} opts.maxChars 总字数上限（默认 600，约 200 token）
 * @param {boolean} opts.touch 是否更新访问计数（召回即"翻账"，会让它不容易被遗忘）
 * @param {boolean} opts.debug 结果里带 scoreParts/mode/cos（内部/调试用，不进提示词）
 * @param {Function} opts.embed 覆盖 embedding 实现（测试/脚本注入）
 * @param {string} opts.model 覆盖向量模型名（缺省按 resolveEmbedModel 解析）
 */
export async function recallMemories({
  query = "", limit = 8, maxChars = 600, touch = true, includeArchived = false,
  debug = false, embed = null, model = "", config = null, now = Date.now(),
  embedTimeoutMs = null,
} = {}) {
  const rows = (listMemories({ status: includeArchived ? "" : "active", limit: 1000 })?.items) || [];
  const cfg = config || loadRecallConfig();
  const timeoutMs = Number(embedTimeoutMs) > 0 ? Number(embedTimeoutMs) : cfg.embedTimeoutMs;

  // 每次召回**只对 query 调一次** embedding；失败/未注入就整体降级（不是逐行调用）
  let queryVec = null, embedError = null, embedMs = 0;
  const embedFn = embed || _embed;
  const useVec = cfg.enabled && String(query).trim() && rows.length && typeof embedFn === "function";
  if (useVec) {
    const t0 = Date.now();
    try { queryVec = await embedFn(String(query), { timeoutMs }); } catch (e) { embedError = String(e?.message || e).slice(0, 200); }
    embedMs = Date.now() - t0;
  }
  const usedModel = queryVec ? resolveEmbedModel(model) : "";
  let vecMap = new Map();
  if (queryVec && usedModel) {
    try { vecMap = listMemoryVectors(rows.map(r => r.memory_id), usedModel); } catch { vecMap = new Map(); }
  }
  if (queryVec && !vecMap.size) queryVec = null; // 查询向量有了但库里一条同模型向量都没有 → 退回旧行为

  const ranked = rows
    .map(row => {
      const rowVec = vecMap.get(row.memory_id) || null;
      const d = scoreDetailed(row, query, now, { queryVec, rowVec, weights: cfg.weights, vecThreshold: cfg.vecThreshold });
      return { row, score: d.score, parts: d.parts, mode: d.mode, cos: d.cos };
    })
    .sort((a, b) => b.score - a.score);

  const { picked, chars } = pickTop(ranked, { limit, maxChars });
  const items = picked.map(e => itemOf(e, debug));

  if (touch && picked.length) {
    for (const p of picked) { try { getMemory(p.id, { touch: true }) } catch { } }
  }
  return {
    items,
    chars,
    scores: items.map(p => p.score),
    mode: queryVec ? "hybrid" : "keyword",
    embed: { ok: !!queryVec, model: usedModel, ms: embedMs, error: embedError, configured: cfg.enabled },
    vectors: { coverage: vecMap.size, rows: rows.length },
    config: { enabled: cfg.enabled, weights: cfg.weights, vecThreshold: cfg.vecThreshold, source: cfg.source },
  };
}

/** 拼成可直接注入提示词的一小段（没有内容时返回空串）。 */
export async function recallPrompt({ query = "", limit = 8, maxChars = 600, embed = null, model = "" } = {}) {
  const { items } = await recallMemories({ query, limit, maxChars, embed, model });
  if (!items.length) return "";
  return `【记得的事】\n${items.map(i => `- ${i.summary}`).join("\n")}`;
}

// ---------------------------------------------------------------------------
// 新旧对照（debug 接口 + scripts/memory-recall-compare.mjs 共用）
// ---------------------------------------------------------------------------
/**
 * 同一次查询跑两套打分：old = 2026-11-06 的纯字面公式；new = 当前配置的混合分。
 * 只读（不 touch、不写库），query 只调一次 embedding，两套排序共用同一批行与 same now。
 */
export async function compareRecall({ query = "", limit = 8, maxChars = 600, embed = null, model = "", now = Date.now(), embedTimeoutMs = null } = {}) {
  const cfg = loadRecallConfig();
  const timeoutMs = Number(embedTimeoutMs) > 0 ? Number(embedTimeoutMs) : cfg.embedTimeoutMs;
  const rows = (listMemories({ status: "active", limit: 1000 })?.items) || [];
  const embedFn = embed || _embed;
  let queryVec = null, embedError = null, embedMs = 0;
  if (cfg.enabled && String(query).trim() && rows.length && typeof embedFn === "function") {
    const t0 = Date.now();
    try { queryVec = await embedFn(String(query), { timeoutMs }); } catch (e) { embedError = String(e?.message || e).slice(0, 200); }
    embedMs = Date.now() - t0;
  }
  const usedModel = queryVec ? resolveEmbedModel(model) : "";
  let vecMap = new Map();
  if (queryVec && usedModel) {
    try { vecMap = listMemoryVectors(rows.map(r => r.memory_id), usedModel); } catch { vecMap = new Map(); }
  }
  if (queryVec && !vecMap.size) queryVec = null;

  const build = (useHybrid) => rows.map(row => {
    const rowVec = vecMap.get(row.memory_id) || null;
    const d = scoreDetailed(row, query, now, {
      queryVec: useHybrid ? queryVec : null, rowVec: useHybrid ? rowVec : null,
      weights: cfg.weights, vecThreshold: cfg.vecThreshold,
    });
    return { row, score: d.score, parts: d.parts, mode: d.mode, cos: d.cos };
  }).sort((a, b) => b.score - a.score);

  const oldRanked = build(false);
  const newRanked = build(true);
  const oldTop = pickTop(oldRanked, { limit, maxChars }).picked;
  const newTop = pickTop(newRanked, { limit, maxChars }).picked;
  const oldRankById = new Map(oldRanked.map((e, i) => [e.row.memory_id, i + 1]));
  const newRankById = new Map(newRanked.map((e, i) => [e.row.memory_id, i + 1]));
  const changed = newTop
    .map(e => {
      const id = e.row.memory_id;
      const oldRank = oldRankById.get(id) ?? null;
      const newRank = newRankById.get(id);
      return { id, summary: String(e.row.summary || "").slice(0, 80), oldRank, newRank, delta: oldRank ? oldRank - newRank : null };
    })
    .filter(x => x.oldRank === null || x.oldRank !== x.newRank);
  const oldSet = new Set(oldTop.map(e => e.row.memory_id));
  const newSet = new Set(newTop.map(e => e.row.memory_id));
  const overlap = [...newSet].filter(id => oldSet.has(id)).length;
  const item = (e, i) => ({
    rank: i + 1, id: e.row.memory_id, summary: String(e.row.summary || ""),
    type: e.row.memory_type, importance: Number(e.row.importance_score ?? 0),
    score: round3(e.score), scoreParts: roundParts(e.parts), mode: e.mode,
    cos: e.cos === null || e.cos === undefined ? null : round3(e.cos),
  });

  return {
    query, limit, maxChars,
    embedding: { ok: !!queryVec, model: usedModel, ms: embedMs, error: embedError, enabled: cfg.enabled },
    vectors: { ...memoryVectorStats(usedModel ? { model: usedModel } : {}), coverageForRows: vecMap.size },
    old: oldTop.map(item),
    new: newTop.map(item),
    diff: {
      top1Changed: (oldTop[0]?.row.memory_id || null) !== (newTop[0]?.row.memory_id || null),
      overlap,
      changed,
    },
    newPrompt: newTop.length ? newTop.map(e => `- ${e.row.summary}`).join("\n") : "",
  };
}
