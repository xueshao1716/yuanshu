// engine/lesson-promotion.mjs —— 复盘教训的「晋升」（2026-10-07）
//
// 复盘每晚都写「教训」，但写完就躺在时间引擎日志里：同一个坑隔天再踩、再写一遍，
// 没有任何东西把它升格成长期经验。这里补的是那一步，规矩和记忆压缩一样：**只提案**。
//   · 复盘 JSON 块可带 lessons:[{text, topic}]，每晚落进教训账（记忆/做梦/教训账.json）；
//   · 新教训与**别的日子**的教训 topic 相同，或字二元组重合够高 → 算复现；
//   · 复现的出一条记忆提案（memory-nudge / subtype=lesson，目标经验库），带来源日期；
//   · 写不写由伙伴点，同一 topic 提过一次就不再提（驳回也算提过）。
// 不用向量：教训短、同一个人写的，topic + 二元组足够；判错的代价只是多一条可驳回的提案。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText } from "./atomic-io.mjs";

export const LESSON_LEDGER = path.join("记忆", "做梦", "教训账.json");
export const LESSON_CAP = 400;
export const SIMILAR_MIN = 0.34;

const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const topicKey = (t) => clean(t, 24).toLowerCase().replace(/[\s·・,，。:：;；、/\\|()（）「」【】"'`-]+/g, "");

/** 复盘最后一个合法 JSON 块里的 lessons；没有 lessons 字段（旧日志/模型漏写）就退回正文的「教训/反思」小节。 */
export function parseReflectionLessons(text, { legacy = true } = {}) {
  const blocks = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const d = JSON.parse(blocks[i][1]);
      if (!Array.isArray(d?.actions) && !Array.isArray(d?.lessons)) continue;
      if (!Array.isArray(d.lessons)) break;
      return d.lessons
        .map((l) => (typeof l === "string" ? { text: l } : l))
        .filter((l) => l && clean(l.text, 200).length >= 6)
        .slice(0, 5)
        .map((l) => ({ text: clean(l.text, 120), topic: clean(l.topic, 24) }));
    } catch { /* 试上一块 */ }
  }
  return legacy ? legacyLessons(text) : [];
}

/** 旧格式：标题含「教训」或「反思」的小节里的列表项（去掉加粗），topic 留空只靠正文比对。 */
export function legacyLessons(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let inSec = 0;
  for (const line of lines) {
    const h = line.match(/^(#{2,4})\s+(.*)$/);
    if (h) { inSec = /教训|反思/.test(h[2]) && !/自动执行/.test(h[2]) ? 1 : 0; continue; }
    if (!inSec) continue;
    const m = line.match(/^\s*(?:\d+[.、)]|[-*])\s+(.+)$/);
    if (!m) continue;
    const t = clean(m[1].replace(/\*\*/g, ""), 120);
    if (t.length >= 6) out.push({ text: t, topic: "" });
    if (out.length >= 5) break;
  }
  return out;
}

function bigrams(s) {
  const t = String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 0..1：topic 相同直接 1，否则按字二元组 Jaccard。 */
export function lessonSimilarity(a, b) {
  const ka = topicKey(a?.topic), kb = topicKey(b?.topic);
  if (ka && kb && ka === kb) return 1;
  const A = bigrams(a?.text), B = bigrams(b?.text);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function loadLessonLedger(wsRoot, fsMod = fs) {
  try {
    const d = JSON.parse(fsMod.readFileSync(path.join(wsRoot, LESSON_LEDGER), "utf8"));
    return { lessons: Array.isArray(d?.lessons) ? d.lessons : [], promoted: Array.isArray(d?.promoted) ? d.promoted : [] };
  } catch { return { lessons: [], promoted: [] }; }
}

/**
 * 纯函数：给定账本和今晚的教训，算出谁复现了（跨日 ≥ minDays 天，含今天）。
 * 已晋升过的（按 topic 或与已晋升文本高度相似）跳过。
 */
export function findRecurringLessons(ledger, lessons, ymd, { minDays = 2, threshold = SIMILAR_MIN } = {}) {
  const past = (ledger?.lessons || []).filter((l) => l.ymd && l.ymd !== ymd);
  const promoted = ledger?.promoted || [];
  const out = [];
  for (const l of lessons || []) {
    if (promoted.some((p) => lessonSimilarity(l, p) >= threshold)) continue;
    const hits = past.filter((p) => lessonSimilarity(l, p) >= threshold);
    const days = [...new Set([...hits.map((h) => h.ymd), ymd])].sort();
    if (days.length < minDays) continue;
    if (out.some((o) => lessonSimilarity(o, l) >= threshold)) continue;
    out.push({ text: l.text, topic: l.topic || hits.find((h) => h.topic)?.topic || "", days, earlier: hits.map((h) => h.text).slice(0, 3) });
  }
  return out;
}

/**
 * 复盘后调用：落账 → 找复现 → 交给 propose（evolution-api 的提案池）→ 记已提。
 * propose(candidate) 返回 {ok}|{skip}；失败不影响落账。
 */
export function promoteReflectionLessons(wsRoot, text, { ymd, now = new Date(), propose, fsMod = fs } = {}) {
  const lessons = parseReflectionLessons(text);
  if (!lessons.length || !ymd) return { recorded: 0, proposed: [] };
  const ledger = loadLessonLedger(wsRoot, fsMod);
  const recurring = findRecurringLessons(ledger, lessons, ymd);
  const at = (now instanceof Date ? now : new Date()).toISOString();
  ledger.lessons.push(...lessons.map((l) => ({ ...l, ymd, at })));
  ledger.lessons = ledger.lessons.slice(-LESSON_CAP);
  const proposed = [];
  for (const c of recurring) {
    let r = null;
    try { r = typeof propose === "function" ? propose(c) : null; } catch { r = null; }
    if (r?.ok) { proposed.push({ ...c, id: r.id }); ledger.promoted.push({ text: c.text, topic: c.topic, at, days: c.days }); }
  }
  const fp = path.join(wsRoot, LESSON_LEDGER);
  fsMod.mkdirSync(path.dirname(fp), { recursive: true });
  atomicWriteText(fp, JSON.stringify(ledger, null, 2), fsMod);
  return { recorded: lessons.length, proposed };
}

/** 提案正文：经验库一行，带来源（复盘日期），和压缩提案同一个出处规矩。 */
export function lessonDraft(c, today) {
  const topic = c.topic ? `[${c.topic}] ` : "";
  return `- [${today}] ${topic}${c.text}（晋升：复盘 ${c.days.length} 天复现；来源：${c.days.join("、")}）`;
}

/** 喂给复盘的已有主题词（近的在前，去重，最多 n 个）：同类教训沿用原词，跨日复现才认得出。 */
export function recentLessonTopics(wsRoot, { n = 24, fsMod = fs } = {}) {
  const seen = new Set(), out = [];
  for (const l of [...loadLessonLedger(wsRoot, fsMod).lessons].reverse()) {
    const t = clean(l.topic, 24), k = topicKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(t);
    if (out.length >= n) break;
  }
  return out;
}
