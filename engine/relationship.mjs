// engine/relationship.mjs —— 关系层（2026-11-09）
// 情绪是分钟级的快变量，关系是月级的慢变量：信任/亲密不随一轮情绪摇摆，
// 只按"这一轮算正向还是负向互动"一点点挪，而且**负向掉得比正向涨得快**（不对称）。
// 落盘 记忆/运行时/关系.json（原子写），notes 只留最近 20 条、每条 ≤120 字。
// 只做展示与 prompt 一行摘要，不参与任何行为门禁——关系读错了不该让她不会说话。

import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomic-io.mjs";

const FILE_REL = path.join("记忆", "运行时", "关系.json");
export const MAX_NOTES = 20;
export const NOTE_MAX = 120;
const WEIGHT_MAX = 2;

// 新关系的底：不是白纸（会默认带点合作意愿），也不是熟人
export const DEFAULT_RELATIONSHIP = Object.freeze({
  trust: 0.25, intimacy: 0.15, interactions: 0, notes: [], firstSeen: null, lastAt: null,
});

// 非对称增量：一次负面 ≈ 2.7 次正面才抵回来（0.08 / 0.03）。
// 负性偏差是刻意的：关系里"裂缝"本来就比"好感"陡；如果正负等幅，吵架会像没发生过。
export const KIND_DELTAS = {
  positive: { trust: 0.03, intimacy: 0.02 },
  negative: { trust: -0.08, intimacy: -0.03 },
  neutral: { trust: 0, intimacy: 0 }, // 中性只记次数，不无条件加分
};

// 正面互动的边际递减（2026-11-09）：trust 越接近 1，同样的好越难再换来信仼，避免
// "刷 25 轮就到 1.0，之后正面互动全无意义"。系数线性归一到基线 trust=0.25：
//   factor = (1 - trust) / (1 - 0.25)，夹 0..1
// 基线处正好 = 1（第一次正面仍是 +0.03，老行为不变），之后：
//   trust 0.5 → ×0.667 = +0.020；0.8 → ×0.267 = +0.008；0.9 → ×0.133 = +0.004；
//   0.95 → ×0.067 = +0.002（永远 > 0，永远涨得动，但涨得极慢）。
// 负面**不软化**（信任掉得快是设计意图）：一次 -0.08 恒定，跌回 0.55 只要 5 次左右。
export const TRUST_SOFTEN_SPAN = Math.max(0.05, 1 - DEFAULT_RELATIONSHIP.trust); // 0.75
export function positiveTrustFactor(trust) {
  const t = clamp01(num(trust, DEFAULT_RELATIONSHIP.trust));
  return clamp01((1 - t) / TRUST_SOFTEN_SPAN);
}
/** 这次正面互动在给定 trust 下能加多少信任（含 weight 乘算，夹 0..2） */
export function positiveTrustGain(trust, weight = 1) {
  const w = Math.max(0, Math.min(WEIGHT_MAX, num(weight, 1)));
  return KIND_DELTAS.positive.trust * w * positiveTrustFactor(trust);
}

// 阶段阈值（仅展示）：先够"亲近"，再"信任"，再"熟悉"，否则陌生。
// 熟悉允许"聊得多"单条达标（次数 8）：天天在一起干活本身就是熟悉，不必靠信任背书。
export const STAGE_RULES = [
  { code: "close", name: "亲近", hit: (s) => s.trust >= 0.8 && s.intimacy >= 0.6 },
  { code: "trust", name: "信任", hit: (s) => s.trust >= 0.55 },
  { code: "familiar", name: "熟悉", hit: (s) => s.trust >= 0.32 || s.interactions >= 8 },
  { code: "stranger", name: "陌生", hit: () => true },
];

let wsRoot = null;
let cache = null;
let cacheRoot = null; // null 表示还没缓存过（"" 是合法根，不能拿来做哨兵）

export function init(root) {
  const next = root || wsRoot || "";
  if (next !== wsRoot) { cache = null; cacheRoot = null; }
  wsRoot = next;
}

export function filePath() {
  return wsRoot ? path.join(wsRoot, FILE_REL) : "";
}

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
// 按码点截断，别把 emoji 的代理对切一半
const cut = (s, n = NOTE_MAX) => Array.from(String(s ?? "").trim()).slice(0, n).join("");
const clone = (st) => ({ ...st, notes: [...st.notes] });

function normalize(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const notes = Array.isArray(o.notes) ? o.notes.filter((n) => typeof n === "string" && n.trim()).map((n) => cut(n)).slice(-MAX_NOTES) : [];
  return {
    trust: clamp01(num(o.trust, DEFAULT_RELATIONSHIP.trust)),
    intimacy: clamp01(num(o.intimacy, DEFAULT_RELATIONSHIP.intimacy)),
    interactions: Math.max(0, Math.floor(num(o.interactions, 0))),
    notes,
    firstSeen: typeof o.firstSeen === "string" && o.firstSeen ? o.firstSeen : null,
    lastAt: typeof o.lastAt === "string" && o.lastAt ? o.lastAt : null,
  };
}

function load() {
  if (cache && cacheRoot === wsRoot) return cache;
  let raw = null;
  try {
    const f = filePath();
    if (f && fs.existsSync(f)) raw = JSON.parse(fs.readFileSync(f, "utf8"));
  } catch { raw = null; } // 文件坏了按默认值起，下一次写盘自然修复；不阻塞聊天
  cache = normalize(raw);
  cacheRoot = wsRoot;
  return cache;
}

function save(st) {
  const f = filePath();
  if (!f) return false;
  try { atomicWriteJson(f, st); return true; } catch { return false; }
}

/** 当前关系快照（拷贝，调用方改不到内存态） */
export function current() { return clone(load()); }

/**
 * 记一次互动。
 * @param {object} o
 * @param {'positive'|'negative'|'neutral'} o.kind 本轮性质
 * @param {number} o.weight 强度倍数，夹 0..2
 * @param {string} o.note 备注（≤120 字，只留最近 20 条）
 */
export function recordInteraction({ kind = "neutral", weight = 1, note = "", now = Date.now } = {}) {
  const st = load();
  const k = KIND_DELTAS[kind] ? kind : "neutral";
  const w = Math.max(0, Math.min(WEIGHT_MAX, num(weight, 1)));
  const d = KIND_DELTAS[k];
  const at = typeof now === "function" ? num(now(), Date.now()) : num(now, Date.now());
  // 正面按当前 trust 软化（越熟越难再涨）；负面恒定 −0.08，掉得快是设计意图
  const trustGain = k === "positive" ? d.trust * w * positiveTrustFactor(st.trust) : d.trust * w;
  st.trust = clamp01(st.trust + trustGain);
  st.intimacy = clamp01(st.intimacy + d.intimacy * w);
  st.interactions += 1;
  st.firstSeen = st.firstSeen || new Date(at).toISOString();
  st.lastAt = new Date(at).toISOString();
  const text = cut(note);
  if (text) {
    st.notes.push(text);
    if (st.notes.length > MAX_NOTES) st.notes = st.notes.slice(-MAX_NOTES);
  }
  save(st);
  return clone(st);
}

/** 一行中文摘要，供 prompt 注入（情绪段旁边） */
export function summary() {
  const st = load();
  return `关系：信任 ${st.trust.toFixed(2)}／亲密 ${st.intimacy.toFixed(2)}（已聊 ${st.interactions} 次）`;
}

/** 阶段名（仅展示）：{ code, name } */
export function stage(input = null) {
  const st = input && typeof input === "object" ? normalize(input) : load();
  const rule = STAGE_RULES.find((r) => r.hit(st)) || STAGE_RULES[STAGE_RULES.length - 1];
  return { code: rule.code, name: rule.name };
}
