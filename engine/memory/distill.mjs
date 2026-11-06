// ===== engine/memory/distill.mjs —— 主动蒸馏（2026-11-06）=====
//
// 为什么要有它：记忆库、园丁、索引都在，但**没有触发点**——
// 只有她"想起来"才写一条，等于没有长期记忆。这里把"每轮对话里值得留下的话"抽出来。
//
// 设计取舍：
//   · 用规则挑候选（便宜、可测），不为了抽记忆再调一次模型；
//   · 只收三类：偏好（我喜欢/不要/以后都）、事实（我是/我的/住在）、结论（结论是/以后应该）；
//   · 寒暄、问句、纯执行过程话一律不收（这就是"遗忘白话"的第一道闸）；
//   · 写库前做一次近重复检查（同类型里摘要高度重合就不重复写，改提升重要性）。
import { addMemory, listMemories } from "./db.mjs";

const PREFERENCE = /(?:我(?:更)?(?:喜欢|偏爱|习惯)|不要|别把|以后都|宁愿|讨厌|受不了|最好是)/;
const FACT = /(?:我是|我的|我叫|我住|我在|我有|生日|纪念日|过敏|不吃|不会)/;
const CONCLUSION = /(?:结论是|以后(?:应该|都|先|别|要|就)|经验是|记住|下次要|下次别|别再|从现在开始)/;

/** 一句能不能进记忆。 */
export function classifySentence(text) {
  const s = String(text || "").trim();
  if (s.length < 6 || s.length > 200) return null;
  if (/^(?:好的|嗯+|哦|谢谢|收到|明白了?|行|可以)[。！？!?]*$/.test(s)) return null;   // 纯寒暄
  if (/[?？]$/.test(s)) return null;                                                 // 问句不是记忆
  if (PREFERENCE.test(s)) return { type: "preference", importance: 0.8 };
  if (CONCLUSION.test(s)) return { type: "fact", importance: 0.75 };
  if (FACT.test(s)) return { type: "fact", importance: 0.65 };
  return null;
}

/** 从一轮对话里抽候选（只看用户说的；她自己的话容易被润色成套话）。 */
export function distillCandidates(messages = []) {
  const out = [];
  const seen = new Set();
  for (const m of messages) {
    if (!m || m.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content) ? m.content.map(b => (typeof b === "string" ? b : b?.text || "")).join(" ") : "";
    for (const raw of String(text).split(/[。！!；;\n]+/)) {
      const kind = classifySentence(raw);
      if (!kind) continue;
      const summary = raw.trim().replace(/\s+/g, " ").slice(0, 200);
      if (seen.has(summary)) continue;
      seen.add(summary);
      out.push({ memory_type: kind.type, summary, importance_score: kind.importance });
    }
  }
  return out;
}

const norm = (s) => String(s || "").replace(/[\s，。！？、,.!?]/g, "").toLowerCase();

/** 近重复：字面重合度 > 0.8 视为同一条。 */
export function isDuplicate(summary, existing = []) {
  const a = norm(summary);
  if (!a) return null;
  for (const e of existing) {
    const b = norm(e.summary);
    if (!b) continue;
    if (a === b) return e;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (longer.startsWith(shorter) && shorter.length >= 6) return e;   // 同一条又补了细节
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.8) return e;
  }
  return null;
}

/**
 * 跑一轮蒸馏。返回 { candidates, added, merged, skipped }。
 * @param {object} opts
 * @param {string} opts.wsRoot  工作区（调用前需 initMemoryDb）
 * @param {Array}  opts.messages 本轮消息
 */
export function distillTurn({ messages = [], dryRun = false } = {}) {
  const candidates = distillCandidates(messages);
  const result = { candidates: candidates.length, added: 0, merged: 0, skipped: 0, items: [] };
  if (!candidates.length) return result;

  const existing = (listMemories({ status: "active", limit: 500 })?.items) || [];
  for (const c of candidates) {
    const dup = isDuplicate(c.summary, existing);
    if (dup) {
      result.merged += 1;
      result.items.push({ action: "merge", id: dup.memory_id, summary: c.summary });
      if (!dryRun) {
        try {
          // 又提了一次 = 这条更重要；顺带刷新确认时间（保鲜）
          const next = Math.min(1, Number(dup.importance_score || 0.5) + 0.05);
          updateImportance(dup.memory_id, next);
        } catch { result.skipped += 1 }
      }
      continue;
    }
    if (dryRun) { result.added += 1; result.items.push({ action: "add", summary: c.summary }); continue }
    try {
      const row = addMemory({ memory_type: c.memory_type, summary: c.summary, importance_score: c.importance_score, source: "auto" });
      existing.push(row);
      result.added += 1;
      result.items.push({ action: "add", id: row.memory_id, summary: c.summary });
    } catch { result.skipped += 1 }
  }
  return result;
}

// 单独拎出来，避免为了 +0.05 就整功能依赖 updateMemory 的签名
import { updateMemory as _updateMemory } from "./db.mjs";
function updateImportance(id, score) {
  _updateMemory(id, { importance_score: score });
}
