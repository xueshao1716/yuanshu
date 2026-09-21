import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openTrace, addNode, closeTrace } from '../../engine/trace.mjs';
import { currentExplorePolicy } from '../../engine/explore-policy.mjs';
const mod = await import('../../engine/evolution-cycle.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
test('real cycle scopes retry evidence, works without skill labels, shadows then enables and rolls back unsupported canary', async t => {
  assert.equal(typeof mod.runEvolutionCycle, 'function');
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cycle-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  function trace(kind, goal, at, attempts = 2) {
    const { trace } = openTrace(wsRoot, { kind, goal, now: at });
    for (let i = 0; i < attempts; i++) addNode(wsRoot, trace.id, { score: 0, cost: 1, outcome: 'failed' });
    closeTrace(wsRoot, trace.id, { score: 0 });
  }
  const opts = { wsRoot, candidates: [], rank: () => [], now: '2026-09-21T00:00:00Z' };
  for (let i = 0; i < 8; i++) trace('story-video', `video${i}`, '2026-09-20T00:00:00Z');
  let result = await mod.runEvolutionCycle(opts);
  assert.equal(result.explore.traces, 0);
  for (let i = 0; i < 8; i++) trace('fix-attempt', `fix${i}`, '2026-09-20T00:00:00Z');
  result = await mod.runEvolutionCycle(opts);
  assert.equal(result.explore.gate.phase, 'shadow');
  assert.equal(currentExplorePolicy(wsRoot).retryOnFailure, 1);
  for (let i = 0; i < 3; i++) trace('fix-attempt', `fresh${i}`, '2026-09-22T00:00:00Z');
  result = await mod.runEvolutionCycle({ ...opts, now: '2026-09-23T00:00:00Z' });
  assert.equal(result.explore.gate.phase, 'canary');
  assert.equal(currentExplorePolicy(wsRoot).retryOnFailure, 0);
  const staleRevoke = await mod.revertEvolution(wsRoot, 'fix-attempt', '2026-09-20T00:00:00Z');
  assert.equal(staleRevoke.ok, false, 'an old ledger entry must not undo a newer enablement');
  assert.equal(currentExplorePolicy(wsRoot).retryOnFailure, 0);
  trace('fix-attempt', 'canary-real-failure', '2026-09-24T00:00:00Z', 1);
  result = await mod.runEvolutionCycle({ ...opts, now: '2026-09-24T01:00:00Z' });
  assert.equal(result.explore.gate.phase, 'rolled_back');
  assert.equal(currentExplorePolicy(wsRoot).retryOnFailure, 1);
});

test('selection never reads held-out task labels', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-holdout-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const { appendEpisodes } = await import('../../engine/dream.mjs');
  const rows = Array.from({ length: 8 }, (_, i) => ({ kind: 'skill-match', runId: `r${i}`, input: `task${i}`,
    at: `2026-09-${10 + i}T00:00:00Z`, choice: 'good',
    verification: { source: 'human', verdict: 'PASS', reference: `review${i}`, skillValidated: true } }));
  appendEpisodes(wsRoot, rows);
  const r = await mod.runEvolutionCycle({ wsRoot, now: '2026-09-21T00:00:00Z',
    candidates: [{ id: 'holdout-only', weights: {} }],
    rank: (ep, p) => p.id === 'holdout-only' && Number(ep.input.slice(4)) >= 5 ? ['good'] : [] });
  assert.equal(r.gate.phase, 'collecting', 'holdout-only advantage cannot choose a candidate');
});

test('equal timestamps use the same deterministic holdout and future samples stay excluded', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-split-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const { appendEpisodes } = await import('../../engine/dream.mjs');
  const tasks = Array.from({ length: 8 }, (_, i) => `same-time-${i}`);
  const key = x => createHash('sha256').update(x).digest('hex');
  const sorted = tasks.toSorted((a, b) => key(a).localeCompare(key(b)));
  appendEpisodes(wsRoot, [...sorted.toReversed(), 'future-only'].map((input, i) => ({ kind: 'skill-match', input,
    runId: `t${i}`, at: i === 8 ? '2030-01-01T00:00:00Z' : '2026-09-20T00:00:00Z', choice: 'good',
    verification: { source: 'human', verdict: 'PASS', reference: `review${i}`, skillValidated: true } })));
  const r = await mod.runEvolutionCycle({ wsRoot, now: '2026-09-21T00:00:00Z',
    candidates: [{ id: 'holdout-only', weights: {} }],
    rank: (ep, p) => p.id === 'holdout-only' && [...sorted.slice(-3), 'future-only'].includes(ep.input) ? ['good'] : [] });
  assert.equal(r.winner, null);
  assert.equal(r.gate.phase, 'collecting');
});
