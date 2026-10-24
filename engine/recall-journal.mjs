// ===== recall-journal.mjs —— 记忆召回台账（ORM：谁被注入、谁真被用）=====
//
// 补的洞：yuanshu-memroute.routeMemory() 只按词面打分、返回纯字符串。
// 于是有两件事一直看不见：
//   ① 这一轮到底把哪几条记忆塞进了提示词（没有 id，事后无法追溯）；
//   ② 塞进去的有没有被用上（没有回流，高分条目永远高分，一次没用的永远占着 Top-5）。
//
// 这里只做三件事，不做模型判断：
//   1. 给每条候选一个稳定 id（source + 归一化正文的哈希），跨轮次可追踪；
//   2. 每轮把"注入过哪几条"记进 记忆/运行时/记忆召回.json，等回复落地后结算；
//   3. "用上了"的证据用**记忆独有词**判断：记忆里有、回复里有、但用户问题里没有。
//
// 为什么不用普通词面重合：用户问"系统怎么了"，回复里必然出现"系统"——那是问题自带的，
// 不是记忆带进来的。只有"用户没提、记忆里有、回复却说了"，才算记忆真的参与了这次回答。
// 这是代理指标不是真相，所以 boost 压在小范围（+3 … -6）：判错也只挪一两位，不会把
// 相关记忆挤掉。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { tokenize } from "./yuanshu-memroute.mjs";

export const RECALL_FILE = path.join("记忆", "运行时", "记忆召回.json");

/** 台账规模上限：stats 是长期累积，必须封顶，否则又是一份只涨不落的大文件。 */
const MAX_STATS = 800;
const MAX_RECENT = 40;
const MAX_PENDING = 6;
/** 待结算召回的保鲜期：跨半小时还没落地（用户跑了/轮次中止）就丢弃，不拿别的回复凑数。 */
const PENDING_TTL_MS = 30 * 60 * 1000;
/** 判"用上了"的门槛：至少 2 个记忆独有词。1 个太容易撞（专名/型号本身就会重复）。 */
export const USED_MIN_NOVEL = 2;

/**
 * 弱证据词：纯数字 + 记忆文件的结构性字段名。
 * 实测（2026-10-24 探针）第一条命中的是 "2026","09","07","15"——每条记忆都带日期头，
 * 任何带日期的回复都会被判成"用上了这条记忆"。这类词证明不了因果，必须剔掉，
 * 否则台账会持续给所有带日期的条目发提权，等于没有回流。
 */
const WEAK_TOKEN_RE = /^\d+$/;
const WEAK_TOKENS = new Set(["topic", "status", "current", "note", "source", "label", "type", "kind", "section", "date", "time"]);

export function isWeakToken(t) {
  return WEAK_TOKEN_RE.test(String(t || "")) || WEAK_TOKENS.has(String(t || "").toLowerCase());
}

function recallPath(wsRoot) {
  return path.join(String(wsRoot || "."), RECALL_FILE);
}

/** 稳定 id：同一条记忆在日志里被重写（缩进/换行变化）也应算同一条。 */
export function memoryId(source, text) {
  const norm = String(text || "").replace(/\s+/g, " ").trim().slice(0, 400);
  return crypto.createHash("sha256").update(`${source || ""}\u0000${norm}`).digest("hex").slice(0, 12);
}

export function emptyJournal() {
  return { version: 1, stats: {}, pending: [], recent: [] };
}

export function loadJournal(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(recallPath(wsRoot), "utf8"));
    if (!raw || typeof raw !== "object") return emptyJournal();
    return {
      version: 1,
      stats: raw.stats && typeof raw.stats === "object" ? raw.stats : {},
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      recent: Array.isArray(raw.recent) ? raw.recent : [],
    };
  } catch { return emptyJournal(); }
}

function prune(state) {
  state.pending = (state.pending || []).slice(-MAX_PENDING);
  state.recent = (state.recent || []).slice(-MAX_RECENT);
  const ids = Object.keys(state.stats || {});
  if (ids.length > MAX_STATS) {
    // 先保"被用过"的，再按注入次数，最后按最近注入时间
    ids.sort((a, b) => {
      const sa = state.stats[a] || {}, sb = state.stats[b] || {};
      return ((sb.used || 0) - (sa.used || 0)) || ((sb.injected || 0) - (sa.injected || 0)) || ((sb.lastInjectedAt || 0) - (sa.lastInjectedAt || 0));
    });
    const keep = {};
    for (const id of ids.slice(0, MAX_STATS)) keep[id] = state.stats[id];
    state.stats = keep;
  }
  return state;
}

export function saveJournal(wsRoot, state) {
  try {
    const p = recallPath(wsRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(prune(state)), "utf8");
    return true;
  } catch { return false; }
}

/**
 * 提权/沉底：被用过的往上抬，注入了 ≥4 次却一次没被用的往下压。
 * 上抬封顶 +3（一次 +2、两次 +3），下沉按注入次数分档到 -6。
 */
export function recallBoost(stat) {
  const injected = Math.max(0, Number(stat?.injected) || 0);
  const used = Math.max(0, Number(stat?.used) || 0);
  if (used > 0) return Math.min(3, 1 + used);
  if (injected >= 4) return -Math.min(6, 2 + Math.floor(injected / 4));
  return 0;
}

/** 打分时用的 id → boost 表（只含有增量的条目，省内存也省得误伤）。 */
export function recallWeights(wsRoot) {
  const out = {};
  try {
    const j = loadJournal(wsRoot);
    for (const [id, st] of Object.entries(j.stats || {})) {
      const b = recallBoost(st);
      if (b) out[id] = b;
    }
  } catch {}
  return out;
}

/** 记忆独有词：记忆里有 ∧ 回复里有 ∧ 用户问题里没有。 */
export function novelHits(memoryText, replyText, queryText) {
  const mem = new Set(tokenize(memoryText));
  if (!mem.size) return [];
  const rep = new Set(tokenize(replyText));
  if (!rep.size) return [];
  const q = new Set(tokenize(queryText));
  const hits = [];
  for (const t of mem) {
    if (isWeakToken(t)) continue;
    if (rep.has(t) && !q.has(t)) hits.push(t);
  }
  return hits;
}

/**
 * 记录本轮注入。同一句用户查询重复记录（重试/重入）只留最新一条，
 * 否则一次重试会把 injected 计两次，把没用过的条目更快"沉底"。
 */
export function recordRecall(wsRoot, { query = "", rows = [], sessionId = "", at = Date.now() } = {}) {
  try {
    const q = String(query || "").trim();
    if (!Array.isArray(rows) || !rows.length) return { recorded: false, reason: "无候选" };
    const state = loadJournal(wsRoot);
    const picked = rows.map((r) => ({
      id: r.id || memoryId(r.source, r.text),
      source: r.source || "",
      score: Number(r.score) || 0,
      text: String(r.text || "").slice(0, 120),
    }));
    state.pending = state.pending.filter((p) => p.query !== q);
    state.pending.push({
      id: `${at}-${crypto.randomBytes(3).toString("hex")}`,
      at,
      query: q,
      sessionId: String(sessionId || ""),
      picked,
    });
    for (const r of picked) {
      const st = state.stats[r.id] || (state.stats[r.id] = { source: r.source, text: r.text, injected: 0, used: 0, lastInjectedAt: 0, lastUsedAt: 0 });
      st.injected = (st.injected || 0) + 1;
      st.lastInjectedAt = at;
      st.source = r.source;
      st.text = r.text;
    }
    saveJournal(wsRoot, state);
    return { recorded: true, ids: picked.map((p) => p.id) };
  } catch { return { recorded: false, reason: "异常" }; }
}

/**
 * 结算：回复落地后调用。优先按用户消息精确配对；配不上就取半小时内最近一条
 * （用户中途改写/并发跑批时兜底），过期宁可不算也不张冠李戴。
 */
export function settleRecall(wsRoot, { userMsg = "", assistantText = "", at = Date.now() } = {}) {
  try {
    const reply = String(assistantText || "").trim();
    if (!reply) return { settled: false, reason: "无回复" };
    const state = loadJournal(wsRoot);
    if (!state.pending.length) return { settled: false, reason: "无待结算召回" };
    const q = String(userMsg || "").trim();
    let idx = state.pending.findIndex((p) => p.query === q);
    if (idx < 0) {
      for (let i = state.pending.length - 1; i >= 0; i--) {
        if (at - Number(state.pending[i].at || 0) <= PENDING_TTL_MS) { idx = i; break; }
      }
    }
    if (idx < 0) { saveJournal(wsRoot, state); return { settled: false, reason: "召回过期" }; }
    const pending = state.pending[idx];
    state.pending.splice(idx, 1);
    const usedIds = [];
    const evidence = [];
    for (const row of pending.picked || []) {
      const hits = novelHits(row.text, reply, pending.query);
      if (hits.length < USED_MIN_NOVEL) continue;
      usedIds.push(row.id);
      const st = state.stats[row.id] || (state.stats[row.id] = { source: row.source, text: row.text, injected: 1, used: 0, lastInjectedAt: at, lastUsedAt: 0 });
      st.used = (st.used || 0) + 1;
      st.lastUsedAt = at;
      evidence.push({ id: row.id, tokens: hits.slice(0, 6) });
    }
    state.recent.push({
      at,
      query: String(pending.query || "").slice(0, 60),
      injected: (pending.picked || []).length,
      used: usedIds.length,
    });
    saveJournal(wsRoot, state);
    return { settled: true, injected: (pending.picked || []).length, used: usedIds.length, ids: usedIds, evidence };
  } catch { return { settled: false, reason: "异常" }; }
}

/** 只读汇总：给 API / 面板用，不改任何东西。 */
export function recallSummary(wsRoot, limit = 12) {
  const state = loadJournal(wsRoot);
  const entries = Object.entries(state.stats || {}).map(([id, st]) => ({
    id,
    source: st.source || "",
    text: String(st.text || "").slice(0, 100),
    injected: Number(st.injected) || 0,
    used: Number(st.used) || 0,
    boost: recallBoost(st),
    lastInjectedAt: Number(st.lastInjectedAt) || 0,
    lastUsedAt: Number(st.lastUsedAt) || 0,
  }));
  entries.sort((a, b) => (b.used - a.used) || (b.injected - a.injected) || (b.lastInjectedAt - a.lastInjectedAt));
  return {
    tracked: entries.length,
    injected: entries.reduce((s, e) => s + e.injected, 0),
    used: entries.reduce((s, e) => s + e.used, 0),
    boosted: entries.filter((e) => e.boost > 0).length,
    sunk: entries.filter((e) => e.boost < 0).length,
    pending: state.pending.length,
    entries: entries.slice(0, Math.max(1, limit)),
    recent: state.recent.slice(-10).reverse(),
  };
}
