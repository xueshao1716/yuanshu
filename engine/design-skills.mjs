// engine/design-skills.mjs —— 把"她原有的手艺"接进委托
//
// 2026-10-19 伙伴：「她原来具备一些这样的知识」——对，技能库里早就有海报方法论
// （xiaoyu-poster-prompt / gc-minimal-zine-poster / image-to-engine …），
// 但委托这条链一直白手起家，没用上。这里做桥：按主体+目标匹配技能，取全文要点拼进提示词。
//
// 分寸：只取 1 个最相关的技能、截 1200 字，避免把提示词撑爆；
// 匹配不到就返回空串，绝不硬塞一个不相干的技能。

import { loadSkillIndex, execActivateSkill } from './context-loader.mjs';
import { matchSkillsForTask } from './yuanshu-protocol.mjs';

export const MAX_SKILL_CHARS = 1200;

/** 从 SKILL.md 全文里摘出"能直接用"的部分：跳过包装行、frontmatter、标题与元数据。 */
export function excerptSkill(raw, max = MAX_SKILL_CHARS) {
  const text = String(raw || '')
    .replace(/^技能\s+\S+\s*已加载[^\n]*\n?/, '') // execActivateSkill 的包装行
    .replace(/^\s*---[\s\S]*?\n---\s*/, '')       // frontmatter（可能在包装行之后）
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^#{1,2}\s/.test(t)) return false;          // 顶级标题没信息量
      if (/^(name|description|license|allowed-tools)\s*:/.test(t)) return false; // 元数据行
      if (/^-{3,}$/.test(t)) return false;            // 残留分隔线
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  // 在句末截断，别把一句话劈成两半
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut) + '…';
}

/**
 * 给一单委托找可沿用的方法。
 * @returns {{name:string, excerpt:string}|null}
 */
export function skillHintFor({ subject = '', goal = '', deliverables = [] } = {}, { skills = null, activate = null } = {}) {
  const query = [subject, goal, ...(Array.isArray(deliverables) ? deliverables : [])].filter(Boolean).join(' ').trim();
  if (query.length < 2) return null;
  try {
    const list = skills || loadSkillIndex();
    const hit = matchSkillsForTask(query, list, 1)[0];
    if (!hit?.name) return null;
    const full = (activate || execActivateSkill)(hit.name);
    const text = typeof full === 'string' ? full : (full?.text || '');
    const excerpt = excerptSkill(text);
    if (!excerpt) return null;
    return { name: hit.name, excerpt };
  } catch { return null }
}

/** 拼成提示词尾部的一段（没有匹配就返回空串）。 */
export function skillBlockFor(commission = {}, deps = {}) {
  const hint = skillHintFor({
    subject: commission.subject,
    goal: commission.goal,
    deliverables: commission.brief?.deliverables,
  }, deps);
  if (!hint) return '';
  return `可沿用的既有方法（技能 ${hint.name}）：\n${hint.excerpt}`;
}
