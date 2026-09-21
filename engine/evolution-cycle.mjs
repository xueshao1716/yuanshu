import { createHash } from 'node:crypto';
import { dream, loadEpisodes, replayPolicy, currentWeights, promoteWeights, writeDreamLog } from './dream.mjs';
import { listTraces, loadTrace } from './trace.mjs';
import { DEFAULT_EXPLORE_POLICY, currentExplorePolicy, exploreCandidates, replayExplore, replayExploreAcross, promoteExplorePolicy } from './explore-policy.mjs';
import { verifiedSkillEpisode } from './trace-evidence.mjs';
import { readEvolution, evaluateEvolution, activateEvolution, policyFingerprint, evolutionRows } from './evolution-gate.mjs';
import { collectTeamEvidence, ingestLatestTeamEvidence } from './team-evolution-evidence.mjs';
import { grant } from './autonomy.mjs';

const group = text => createHash('sha256').update(String(text).trim().replace(/\s+/g, ' ')).digest('hex');
const pending = state => state && !['collecting', 'superseded', 'rejected', 'rolled_back'].includes(state.phase);
const monitoring = state => ['canary', 'active', 'rollback_required'].includes(state?.phase);
function discovery(items, input, now) {
  const unique = evolutionRows(items.map(e => ({ id: e.runId || e.id, group: group(input(e)), at: e.at, sample: e })), now);
  return unique.length < 8 ? [] : unique.slice(0, -3).map(r => r.sample);
}

async function advance(wsRoot, { domain, current, chosen, rows, apply, now }) {
  if (!chosen) return { phase: 'collecting', reason: '没有覆盖充分且优于现役的候选策略' };
  let gate = evaluateEvolution(wsRoot, { domain, baseline: current, candidate: chosen, rows, now });
  let autonomy = null;
  const activate = () => activateEvolution(wsRoot, { domain, current, apply, now });
  if (gate.phase === 'rollback_required') {
    autonomy = await activate();
  } else if (gate.phase === 'ready') {
    autonomy = await grant({ kind: 'config', text: `调整${domain === 'fix-attempt' ? '修复重试' : '技能匹配'}策略为 ${chosen.id}` },
      { replayable: true, episodes: rows.length, noWorse: true, betterCount: 1, reversible: true, scope: 'config',
        text: '发现集、独立保留组和后续真实任务均通过；进入有期限试运行' },
      { wsRoot, now, previous: gate.baseline, apply: activate });
  }
  return { ...readEvolution(wsRoot, domain), autonomy };
}

// One promise per workspace prevents timer/manual runs from racing promotion.
const running = new Map();
export function runEvolutionCycle(options) {
  if (running.has(options.wsRoot)) return running.get(options.wsRoot);
  const promise = cycle(options).finally(() => running.delete(options.wsRoot));
  running.set(options.wsRoot, promise);
  return promise;
}
async function cycle({ wsRoot, candidates = [], rank, matcherContext = 'matcher-v1', now = new Date() }) {
  const episodes = loadEpisodes(wsRoot, { kind: 'skill-match' });
  const active = currentWeights(wsRoot);
  const context = group(matcherContext);
  const current = { id: active.id || 'matcher-current', weights: active.weights, context };
  const state = readEvolution(wsRoot, 'skill-match');
  const baseline = monitoring(state) ? state.baseline : current;
  const result = dream({ kind: 'skill-match', episodes: discovery(episodes.filter(verifiedSkillEpisode), e => e.input, now), incumbentId: baseline.id,
    candidates: [{ ...baseline }, ...candidates.filter(c => c.id !== baseline.id)], rank });
  const chosen = pending(state) ? state.candidate : candidates.find(c => c.id === result.winner);
  const policy = chosen ? { ...chosen, context } : null;
  const skillRows = episodes.filter(verifiedSkillEpisode).map(ep => {
    const score = p => ({ score: replayPolicy(p, [ep], { rank }).total, cost: 0, covered: true });
    return { id: ep.runId, group: group(ep.input), at: ep.at, baseline: score(baseline), candidate: policy ? score(policy) : null };
  });
  const gate = await advance(wsRoot, { domain: 'skill-match', current, chosen: policy, rows: skillRows, now,
    apply: p => promoteWeights(wsRoot, p.id, p.weights, { now }) });
  if (result.ok) writeDreamLog(wsRoot, 'skill-match', { ...result, winner: null, proposal: null });

  // Only the fix runtime consumes this retry policy. Story/delegation/Team
  // histories cannot be counterfactual evidence about its behavior.
  const traces = listTraces(wsRoot, { kind: 'fix-attempt', limit: 300 })
    .map(t => loadTrace(wsRoot, t.id)).filter(t => t?.closed && t?.nodes?.length);
  const cur = currentExplorePolicy(wsRoot);
  const exState = readEvolution(wsRoot, 'fix-attempt');
  const exBase = monitoring(exState) ? exState.baseline : cur;
  const ex = { ...replayExploreAcross(discovery(traces, t => t.goal, now), { incumbentId: exBase.id, incumbent: exBase }), traces: traces.length };
  const exChosen = pending(exState) ? exState.candidate : exploreCandidates().find(c => c.id === ex.winner);
  const exPolicy = exChosen ? { ...DEFAULT_EXPLORE_POLICY, ...exChosen } : null;
  const exRows = traces.map(t => ({ id: t.id, group: group(t.goal), at: t.at,
    baseline: replayExplore(t, exBase), candidate: exPolicy ? replayExplore(t, exPolicy) : null }));
  const exGate = await advance(wsRoot, { domain: 'fix-attempt', current: cur, chosen: exPolicy, rows: exRows, now,
    apply: p => promoteExplorePolicy(wsRoot, p.id, p, { now }) });
  ingestLatestTeamEvidence(wsRoot);
  const team = collectTeamEvidence(wsRoot);
  return { ...result, ok: true, gate, explore: { ...ex, gate: exGate },
    team: { observed: team.length, accepted: team.filter(r => r.accepted).length, records: team.slice(-20) },
    note: '历史回放与后续观察均有覆盖边界，不保证未来任务不退步。' };
}

export function evolutionStatus(wsRoot) {
  const team = collectTeamEvidence(wsRoot);
  return { skill: readEvolution(wsRoot, 'skill-match'), explore: readEvolution(wsRoot, 'fix-attempt'),
    team: { observed: team.length, accepted: team.filter(r => r.accepted).length, records: team.slice(-10) } };
}

export async function revertEvolution(wsRoot, domain, enabledAt) {
  const state = readEvolution(wsRoot, domain);
  const current = domain === 'fix-attempt' ? currentExplorePolicy(wsRoot) : currentWeights(wsRoot);
  if (!state || !['canary', 'active'].includes(state.phase)) return { ok: false, reason: '没有在用的试运行策略' };
  if (!enabledAt || state.enabledAt !== enabledAt) return { ok: false, reason: '该记录不是当前启用的策略' };
  // Do not overwrite subsequent user edits.
  const target = domain === 'fix-attempt' ? current : { ...current, context: state.candidate.context };
  if (policyFingerprint(target) !== policyFingerprint(state.candidate)) return { ok: false, reason: '配置已改变' };
  return activateEvolution(wsRoot, { domain, current: target, revokeAt: enabledAt, apply: p => domain === 'fix-attempt'
    ? promoteExplorePolicy(wsRoot, p.id, p) : promoteWeights(wsRoot, p.id, p.weights) });
}
