import { createHash } from 'node:crypto';
import { loadEpisodes } from './dream.mjs';
import { verifiedSkillEpisode } from './trace-evidence.mjs';
import { evolutionRows } from './evolution-gate.mjs';

export function loadSkillEvidence(wsRoot, taskEvidence) {
  const reviewed = new Set(taskEvidence?.reviewedIds() || []);
  // A current review always overrides older labels for the same run, even revoked ones.
  return [...loadEpisodes(wsRoot, { kind: 'skill-match' }).filter(e => !reviewed.has(e.runId)), ...(taskEvidence?.episodes() || [])];
}
export function evolutionProgress(episodes, state, now = new Date()) {
  const eligible = episodes.filter(verifiedSkillEpisode);
  const rows = evolutionRows(eligible.map(e => ({ id: e.runId, at: e.at,
    group: createHash('sha256').update(String(e.input).trim().replace(/\s+/g, ' ')).digest('hex') })), now);
  const current = state?.phase || 'collecting';
  return { observed: episodes.length, qualified: eligible.length, groups: rows.length,
    phase: current, reason: state?.reason || '等待真实任务验收及有收益的候选；样本数量达标不代表策略通过',
    discovery: { count: rows.length >= 8 ? rows.length - 3 : Math.min(5, rows.length), required: 5 },
    holdout: { count: rows.length >= 8 ? 3 : Math.max(0, rows.length - 5), required: 3 },
    future: { count: state?.future || 0, required: 3 }, canary: { count: state?.monitored || 0, required: 5 },
    candidate: state?.candidate?.id || null, enabled: ['canary', 'active'].includes(current),
    expiresAt: state?.expiresAt || null, checkedAt: state?.checkedAt || null,
    note: '发现与保留组按任务内容去重；后续任务按实际运行时间划分。任务合格与技能正确需分别确认。' };
}
