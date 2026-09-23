import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteText } from './atomic-io.mjs';

const domains = new Set(['fix-attempt', 'skill-match']);
function statePath(root, domain) {
  if (!domains.has(domain)) throw new Error('unsupported evolution domain');
  return path.join(root, '记忆', '做梦', `evolution-${domain}.json`);
}
// Ignore storage timestamps, but include every effective configuration value.
export function policyFingerprint(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().filter(k => k !== 'at').map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function readEvolution(root, domain) {
  try { return JSON.parse(fs.readFileSync(statePath(root, domain), 'utf8')); } catch { return null; }
}
function save(root, state) {
  const file = statePath(root, state.domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteText(file, JSON.stringify(state, null, 2));
  return state;
}
const valid = r => r?.covered === true && Number.isFinite(r.score) && Number.isFinite(r.cost) && r.cost >= 0;
const worse = r => !valid(r.baseline) || !valid(r.candidate) || r.candidate.score < r.baseline.score || r.candidate.cost > r.baseline.cost;
const better = r => !worse(r) && (r.candidate.score > r.baseline.score || r.candidate.cost < r.baseline.cost);
const phase = (s, value, reason) => ({ ...s, phase: value, reason });
const evidenceOf = rows => rows.map(r => ({ id: r.id, group: r.group, reference: r.reference || null }));
const lostEvidence = (state, rows) => (state.evidence || []).some(e =>
  !rows.some(r => r.id === e.id && r.group === e.group && (r.reference || null) === e.reference));

// Selection and validation must use exactly the same groups and tie-breaks.
export function evolutionRows(rows, now = new Date()) {
  const ordered = rows.filter(r => r.id && r.group && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) <= Date.parse(now))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id));
  return [...new Map(ordered.map(r => [r.group, r])).values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.group.localeCompare(b.group));
}

// Offline comparison never invents model output or spends money. New observations
// must come from real later tasks; repeated task groups cannot refill a holdout.
export function evaluateEvolution(root, { domain, baseline, candidate, rows = [], now = new Date() }) {
  const at = new Date(now).toISOString();
  let state = readEvolution(root, domain);
  const unique = evolutionRows(rows, now);
  const write = s => save(root, { ...s, checkedAt: at });
  if (state && ['canary', 'active', 'rollback_required'].includes(state.phase)) {
    if (policyFingerprint(baseline) !== policyFingerprint(state.candidate))
      return write(phase(state, 'superseded', '现役配置已由其他操作改变，停止自动改动'));
    if (lostEvidence(state, rows)) return write(phase(state, 'rollback_required', '支撑策略的验收证据已失效或撤回，恢复原配置'));
    const fresh = unique.filter(r => Date.parse(r.at) > Date.parse(state.enabledAt));
    if (state.phase === 'rollback_required' || fresh.some(worse) ||
        (state.phase === 'canary' && Date.parse(at) > Date.parse(state.expiresAt)))
      return write(phase(state, 'rollback_required', '后续结果退步、覆盖不足或试运行过期，恢复原配置'));
    return write({ ...state, phase: fresh.length >= 5 ? 'active' : state.phase, monitored: fresh.length,
      evidence: [...(state.evidence || []), ...evidenceOf(fresh).filter(e => !state.evidence?.some(p => p.id === e.id))] });
  }
  if (!state || policyFingerprint(state.baseline) !== policyFingerprint(baseline) ||
      policyFingerprint(state.candidate) !== policyFingerprint(candidate)) {
    state = { schema: 1, domain, baseline, candidate, phase: 'collecting', createdAt: at };
  }
  if (['rejected', 'rolled_back'].includes(state.phase)) return state;
  if (['shadow', 'ready'].includes(state.phase)) {
    if (lostEvidence(state, rows)) return write(phase(state, 'rejected', '支撑候选的验收证据已失效或撤回，需要重新评估'));
    const fresh = unique.filter(r => Date.parse(r.at) > Date.parse(state.shadowAt) && !state.groups.includes(r.group));
    if (fresh.some(worse)) return write(phase(state, 'rejected', '后续真实任务未通过比较'));
    return write({ ...phase(state, fresh.length >= 3 ? 'ready' : 'shadow',
      fresh.length >= 3 ? '保留样本和后续真实任务已通过，等待治理检查' : '等待至少 3 组后续真实任务'), future: fresh.length,
      evidence: [...(state.evidence || []), ...evidenceOf(fresh).filter(e => !state.evidence?.some(p => p.id === e.id))] });
  }
  if (unique.length < 8) return write({ ...phase(state, 'collecting', '至少需要 8 组独立任务（5 组发现、3 组保留验证）'), samples: unique.length });
  const train = unique.slice(0, -3), holdout = unique.slice(-3);
  state = { ...state, train: train.length, holdout: holdout.length, groups: unique.map(r => r.group), evidence: evidenceOf(unique) };
  if (unique.some(worse) || !train.some(better)) return write(phase(state, 'rejected', '发现集无收益或保留样本退步/覆盖不足'));
  return write({ ...phase(state, 'shadow', '历史比较通过，等待后续真实任务'), shadowAt: at, future: 0 });
}

// Called only behind governance on enablement; rollback restores the complete
// previous config, not a guessed default or candidate ID lookup.
export async function activateEvolution(root, { domain, current, apply, now = new Date(), revokeAt }) {
  let state = readEvolution(root, domain);
  if (revokeAt !== undefined) {
    if (!['canary', 'active'].includes(state?.phase) || state.enabledAt !== revokeAt)
      return { ok: false, reason: '该记录不是当前启用的策略，不能撤销其他轮次' };
    state = phase(state, 'rollback_required', '用户撤销本次策略启用');
  }
  const rollback = state?.phase === 'rollback_required';
  if (!rollback && state?.phase !== 'ready') return { ok: false, reason: '证据闸门尚未通过' };
  if (policyFingerprint(current) !== policyFingerprint(rollback ? state.candidate : state.baseline))
    return { ok: false, reason: '现役配置已经变化' };
  const at = new Date(now).toISOString();
  if (revokeAt !== undefined) save(root, state);
  // Persist rollback intent before changing the effective config; retry after a crash is safe.
  if (!rollback) save(root, { ...state, phase: 'rollback_required', reason: '启用尚未完成', enabledAt: at });
  let result;
  try { result = await apply(rollback ? state.baseline : state.candidate); }
  catch (e) { return { ok: false, reason: String(e.message) }; }
  if (result?.ok !== true) { save(root, state); return { ok: false, reason: result?.error || '配置写入失败' }; }
  const next = rollback ? phase(state, 'rolled_back', '已恢复完整原配置') : {
    ...phase(state, 'canary', '受限试运行：5 组后续任务，最多 7 天；退步或覆盖不足即回滚'), enabledAt: at,
    expiresAt: new Date(Date.parse(at) + 7 * 86400000).toISOString(), monitored: 0 };
  save(root, next);
  return { ok: true, phase: next.phase, undo: `evolution:${domain}`, previous: state.baseline };
}
