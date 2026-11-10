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

// ── 收轮判负向（2026-11-10 P0-1）────────────────────────────────────────
// 旧逻辑是 `turnToolFailures ? "negative" : "positive"`：工具只要非零退出就按 −0.08 扣信任。
// 但 exit≠0 太常见了（grep 没命中、探路命令、检查脚本故意 exit 1），一次"没查到"不等于一次
// 关系裂缝——四次就把 trust 打到 0.0144。新的判据只认两类**明确**的负向证据：
//   ① 用户原话里明确不满（不是"这个 bug 怎么修"这类技术词，见 DISSATISFIED_MARKERS）
//   ② 同一条命令在本轮失败 ≥3 次（换了命令/换了文件是探索，不算撞墙）
// 其余一律 neutral：只记互动次数，不动 trust/亲密。正面也不自动记——没失败不等于被认可，
// 正向证据在 praise-ledger（用户明确道谢 / 交付门 GREEN）。
export const REPEATED_FAILURE_LIMIT = 3;

// 只收"说得出口就是不满"的词。刻意不收「失败 / 报错 / bug / 不行」：它们在正常排障里天天出现
// （emotion.mjs 的 user_frustrated 词表也是这个取舍），拿来判关系会误伤。
export const DISSATISFIED_MARKERS = Object.freeze([
  "不对", "错了", "搞错", "又错", "还是错", "不是这样", "不是这个意思", "你听错", "我说的是",
  "没用", "没有用", "没做到", "做不到", "白做", "白费", "太差", "差劲", "离谱", "垃圾", "废话",
  "敷衍", "糊弄", "别这样", "别再", "听不懂", "答非所问",
  "失望", "生气", "气死", "烦死", "受够了", "无语", "搞什么",
]);

// 命中词但语境不是"怪她"的：用户自责、正常描述。宁可漏判，不可误判（误判直接掉 trust）。
const NOT_DISSATISFIED = [
  /没用过/,                              // 「这个功能我没用过」
  /(?:我|俺)(?:也|是不是|真的)?错了/,     // 用户自责
];

/** 用户这句话是不是在明确表达不满。拿不准一律 false。 */
export function judgeDissatisfaction(userText = "") {
  const raw = String(userText || "").trim();
  if (!raw) return { dissatisfied: false, reason: "没有用户原话" };
  if (raw.length > 600) return { dissatisfied: false, reason: "一段话太长，分不清是不是在说这一轮" };
  const text = raw.replace(/\s+/g, " ");
  const excused = NOT_DISSATISFIED.find((re) => re.test(text));
  if (excused) return { dissatisfied: false, reason: "像自我归因或正常描述，不算怪她" };
  const marker = DISSATISFIED_MARKERS.find((m) => text.includes(m));
  return marker
    ? { dissatisfied: true, marker }
    : { dissatisfied: false, reason: "没有明确的不满词" };
}

/** 同一条命令本轮最多失败了几次（工具事件形状与 antiPatternEvents 一致）。 */
export function maxSameCommandFailures(events = []) {
  const counts = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || (ev.type && ev.type !== "tool") || ev.ok !== false) continue;
    const args = ev.args && typeof ev.args === "object" ? ev.args : {};
    const raw = args.command ?? args.cmd ?? args.code;
    const cmd = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 160) : "";
    if (!cmd) continue; // 没命令的（read/write 之类）不算"同一条命令"
    const key = `${String(ev.name || "")}::${cmd}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts.size ? Math.max(...counts.values()) : 0;
}

/**
 * 收轮互动性质：negative 只在"用户明确不满"或"同一命令失败 ≥3 次"时成立，其余 neutral。
 * @returns {{kind:'negative'|'neutral', reason:string, note:string, marker?:string, repeated?:number}}
 */
export function judgeTurnKind({ userText = "", toolEvents = [], repeatedFailures = null } = {}) {
  const bad = judgeDissatisfaction(userText);
  if (bad.dissatisfied) {
    return { kind: "negative", reason: `用户明确不满（「${bad.marker}」）`, note: `用户明确不满「${bad.marker}」` };
  }
  const n = Number.isFinite(+repeatedFailures)
    ? Math.max(0, Math.floor(+repeatedFailures))
    : maxSameCommandFailures(toolEvents);
  if (n >= REPEATED_FAILURE_LIMIT) {
    return { kind: "negative", reason: `同一条命令本轮失败 ${n} 次`, note: `同一命令本轮失败 ${n} 次` };
  }
  return {
    kind: "neutral",
    reason: n > 0
      ? `工具失败 ${n} 次，但没到「同一条命令 ≥${REPEATED_FAILURE_LIMIT} 次」`
      : "没有明确不满，也没有同一条命令反复失败",
    note: "", // neutral 只计次数：不留备注，notes 不该被"本轮正常"刷满
  };
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
