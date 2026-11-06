// ===== engine/memory/recall.mjs —— 召回（2026-11-06）=====
//
// 长期记忆不能"全量塞进提示词"（那正是 token 浪费的主因之一）。
// 这里按 相关性 × 时效 × 重要性 打分，只取 top-N，并且限量字数。
import { listMemories, getMemory } from "./db.mjs";

const DAY = 86400000;

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

/** 综合打分：相关性 0.55 + 重要性 0.3 + 时效 0.15 */
export function scoreMemory(row, query, now = Date.now()) {
  const rel = relevance(query, row.summary);
  const imp = Math.max(0, Math.min(1, Number(row.importance_score ?? 0.5)));
  const last = Number(row.last_accessed_at || row.updated_at || row.created_at || now);
  const ageDays = Math.max(0, (now - last) / DAY);
  const freshness = Math.max(0, 1 - ageDays / 180);   // 半年线性衰减
  return rel * 0.55 + imp * 0.3 + freshness * 0.15;
}

/**
 * 召回 top-N。
 * @param {object} opts
 * @param {string} opts.query 当前用户这句话（用于相关性）
 * @param {number} opts.limit 条数（默认 8）
 * @param {number} opts.maxChars 总字数上限（默认 600，约 200 token）
 * @param {boolean} opts.touch 是否更新访问计数（召回即"翻账"，会让它不容易被遗忘）
 */
export function recallMemories({ query = "", limit = 8, maxChars = 600, touch = true, includeArchived = false } = {}) {
  const rows = (listMemories({ status: includeArchived ? "" : "active", limit: 1000 })?.items) || [];
  const ranked = rows
    .map(row => ({ row, score: scoreMemory(row, query) }))
    .sort((a, b) => b.score - a.score);

  const picked = [];
  let chars = 0;
  for (const { row, score } of ranked) {
    if (picked.length >= limit) break;
    const text = String(row.summary || "");
    if (!text) continue;
    if (chars + text.length > maxChars && picked.length > 0) continue;
    picked.push({ id: row.memory_id, summary: text, type: row.memory_type, score: Number(score.toFixed(3)) });
    chars += text.length;
  }

  if (touch && picked.length) {
    for (const p of picked) { try { getMemory(p.id, { touch: true }) } catch {} }
  }
  return { items: picked, chars, scores: picked.map(p => p.score) };
}

/** 拼成可直接注入提示词的一小段（没有内容时返回空串）。 */
export function recallPrompt({ query = "", limit = 8, maxChars = 600 } = {}) {
  const { items } = recallMemories({ query, limit, maxChars });
  if (!items.length) return "";
  return `【记得的事】\n${items.map(i => `- ${i.summary}`).join("\n")}`;
}
