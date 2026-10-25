// ===== knowledge-enrich.mjs —— 把"原文截断"变成"可用的 claim"（2026-10-26）=====
//
// 现状（真机量的）：592 条 entry 里 claimKey 只有 7 条、verified 全 false、
// 正文是对话原文截断（平均 709 字），TTL 一律 7 天，514 条已过期。
// 结论：那叫"归档"，不叫"沉淀"。用户的话：沉淀台是看货，货得是真的。
//
// 这里做两件事，都只靠规则（不花模型钱）：
//   1. 从原文里抽出 **claim**（决定/偏好/事实/教训），带类型、置信度、原文证据；
//   2. 按 claim 类型给 **寿命**：长期 90 天、中期 30 天、短 7 天。
//      会话里的"好了/收到"这类碎片就该很快消失，而"以后都用 pnpm"这种要活得久。
//
// 设计原则：抽不出 claim 的条目不硬编，标 claimType='source_excerpt'、寿命短——
// **让它自然过期，比假装它是知识更诚实**。
import { createHash } from "node:crypto";

export const DAY = 86400 * 1000;
export const TTL_BY_DURABILITY = { long: 90 * DAY, medium: 30 * DAY, short: 7 * DAY };
export const DURABILITY_BY_CLAIM = { decision: "long", preference: "long", lesson: "long", fact: "medium", observation: "medium", source_excerpt: "short" };

const MAX_CLAIMS = 4;
const MIN_CLAIM_LEN = 6;

const PATTERNS = [
  // 决定：以后就按这个办
  { type: "decision", re: /(?:决定|定了|定为|采用|统一成|统一用|以后就|就按|就这样定|敲定)[：:，, ]?\s*([^\n。；;]{6,60})/g },
  // 偏好：喜好与禁忌
  { type: "preference", re: /(?:不要再|别再用|不要用|不喜欢|更希望|最好别|倾向于|我要求)[：:，, ]?\s*([^\n。；;]{4,60})/g },
  // 教训：踩过的坑与根因
  { type: "lesson", re: /(?:教训|踩坑|坑是|原因是|根因是|结论是|原来是|问题在于)[：:，, ]?\s*([^\n。；;]{6,80})/g },
  // 事实：带版本号 / 路径 / 数字的陈述
  { type: "fact", re: /([^\n。；;]{0,40}(?:\d+(?:\.\d+){1,3}|\d+\s*(?:秒|分钟|小时|天|GB|MB|KB|%|条|行)|[A-Za-z]:\\|\/[\w.-]+\/|v\d+\.\d+)[^\n。；;]{0,60})/g },
];

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim().replace(/[，,。；;：:]+$/, "");
}

function keyOf(type, value) {
  // claimKey 要能"同义合并"：同一类里取前 12 个字做键，去掉数字差异
  const base = normalize(value).replace(/[0-9]+/g, "#").slice(0, 12);
  return `${type}:${createHash("sha1").update(base).digest("hex").slice(0, 10)}`;
}

/** 从一段原文里抽 claim（去重、限 4 条、按类型置信度）。 */
export function extractClaims(text) {
  const src = String(text || "");
  if (!src.trim()) return [];
  const seen = new Set();
  const out = [];
  const confidenceOf = { decision: 0.9, preference: 0.85, lesson: 0.8, fact: 0.6 };
  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) && out.length < MAX_CLAIMS) {
      const value = normalize(m[1]);
      if (value.length < MIN_CLAIM_LEN) continue;
      const key = keyOf(type, value);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, key, value, confidence: confidenceOf[type], evidence: normalize(m[0]).slice(0, 120) });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CLAIMS);
}

/** 一条 entry 的寿命：按它最强的那条 claim 定；抽不出就是短命。 */
export function durabilityOf(claims = []) {
  if (!claims.length) return "short";
  const rank = { long: 3, medium: 2, short: 1 };
  return claims.reduce((best, c) => {
    const d = DURABILITY_BY_CLAIM[c.type] || "short";
    return rank[d] > rank[best] ? d : best;
  }, "short");
}

/**
 * 富化一条 entry（纯函数，不碰磁盘）。
 * - 写入 claims[]、claimType、claimKey/claimValue（取最强那条）、durability
 * - 重算 expiresAt
 * - 原文截断保留为 text（前 1200 字），另给 summary（claims 首条或前 120 字）
 */
export function enrichEntry(entry = {}, { now = Date.now() } = {}) {
  const text = String(entry.text || "");
  const claims = Array.isArray(entry.claims) && entry.claims.length ? entry.claims : extractClaims(text);
  const primary = claims[0] || null;
  const durability = durabilityOf(claims);
  const ttl = TTL_BY_DURABILITY[durability];
  const createdAt = Number(entry.createdAt) || now;
  return {
    ...entry,
    text: text.slice(0, 1200),
    claims,
    claimCount: claims.length,
    claimType: primary?.type || "source_excerpt",
    claimKey: primary?.key || entry.claimKey || null,
    claimValue: primary?.value || entry.claimValue || null,
    durability,
    summary: primary?.value || normalize(text).slice(0, 120),
    expiresAt: createdAt + ttl,
    ttlDays: Math.round(ttl / DAY),
    enrichedAt: now,
  };
}

/** 给"用了这条知识"续命：被引用说明它有用，别让它在 7 天后自己消失。 */
export function renewOnUse(entry = {}, { now = Date.now(), uses = 0 } = {}) {
  if (!uses) return entry;
  const ttl = TTL_BY_DURABILITY[entry.durability] || TTL_BY_DURABILITY.medium;
  const bump = DURABILITY_BY_CLAIM.medium === ttl ? ttl : ttl; // 每次引用续一个完整周期
  return { ...entry, expiresAt: Math.max(Number(entry.expiresAt) || 0, now + bump), renewedAt: now, renewCount: (Number(entry.renewCount) || 0) + 1 };
}
