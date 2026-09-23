import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from '../../engine/run-store.mjs';
import { createRunEventLog } from '../../engine/run-event-log.mjs';
import { createTaskEvidence } from '../../engine/task-evidence.mjs';
import { runEvolutionCycle, evolutionStatus } from '../../engine/evolution-cycle.mjs';
import { evaluateEvolution, activateEvolution } from '../../engine/evolution-gate.mjs';

test('review arriving during an existing cycle queues a fresh evidence read', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-fresh-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  let reads = 0;
  const options = { wsRoot, rank: () => [], taskEvidence: { reviewedIds: () => [], episodes: () => { reads++; return []; } } };
  const first = runEvolutionCycle(options);
  assert.equal(runEvolutionCycle(options), first);
  const fresh = runEvolutionCycle({ ...options, fresh: true });
  await Promise.all([first, fresh]);
  assert.equal(reads, 2, 'a saved review must not reuse the old in-flight snapshot');
});

test('human-reviewed actual runs enter existing discovery and holdout; withdrawal invalidates shadow evidence', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-cycle-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const rootDir = path.join(wsRoot, 'runtime');
  const store = createRunStore({ rootDir, now: () => '2026-09-20T00:00:00Z' });
  const log = createRunEventLog({ rootDir });
  const taskEvidence = createTaskEvidence({ wsRoot, rootDir });
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const run = store.create({ sessionId: 's', clientRequestId: `r${i}`, message: `task ${i}` });
    ids.push(run.id);
    for (const [type, data] of [['tool', { id: 'skill', name: 'activate_skill', args: { name: 'good' } }],
      ['tool_end', { id: 'skill', name: 'activate_skill', isError: false }], ['delta', { text: 'result' }]])
      log.append({ runId: run.id, sessionId: 's', type, data });
    store.update(run.id, { status: 'completed' });
    taskEvidence.review(run.id, { digest: taskEvidence.get(run.id).digest, revision: null, verdict: 'pass', skills: ['good'], note: 'checked' });
  }
  const opts = { wsRoot, taskEvidence, now: '2026-09-21T00:00:00Z', candidates: [{ id: 'better', weights: {} }],
    rank: (ep, p) => p.id === 'better' ? ['good'] : [] };
  const result = await runEvolutionCycle(opts);
  assert.equal(result.gate.phase, 'shadow');
  assert.equal(result.gate.train, 5);
  assert.equal(result.gate.holdout, 3);
  const progress = evolutionStatus(wsRoot, { taskEvidence, now: opts.now }).progress;
  assert.equal(progress.qualified, 8);
  assert.equal(progress.groups, 8);
  assert.equal(progress.future.required, 3);
  assert.equal(progress.canary.required, 5);
  const row = taskEvidence.get(ids[0]);
  taskEvidence.review(ids[0], { digest: row.digest, revision: row.review.revision, verdict: 'revoke', skills: [], note: 'withdrawn' });
  const after = await runEvolutionCycle(opts);
  assert.equal(after.gate.phase, 'rejected');
  assert.match(after.gate.reason, /证据/);
  assert.equal(evolutionStatus(wsRoot, { taskEvidence, now: opts.now }).progress.qualified, 7);
  assert.equal(after.explore.traces, 0, 'acceptances do not manufacture retry traces');
});

test('canary requires the exact historical evidence, including label revision, to remain valid', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseline = { id: 'old' }, candidate = { id: 'new' };
  const rows = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, group: `g${i}`, at: '2026-09-20T00:00:00Z',
    reference: `review${i}`, baseline: { score: 0, cost: 0, covered: true }, candidate: { score: 1, cost: 0, covered: true } }));
  const opts = { domain: 'skill-match', baseline, candidate, rows, now: '2026-09-21T00:00:00Z' };
  assert.equal(evaluateEvolution(root, opts).phase, 'shadow');
  rows.push(...Array.from({ length: 3 }, (_, i) => ({ ...rows[i], id: `f${i}`, group: `future${i}`, at: '2026-09-22T00:00:00Z' })));
  assert.equal(evaluateEvolution(root, { ...opts, now: '2026-09-23T00:00:00Z' }).phase, 'ready');
  await activateEvolution(root, { domain: 'skill-match', current: baseline, apply: () => ({ ok: true }), now: '2026-09-23T00:00:00Z' });
  rows[0].reference = 'new-label';
  assert.equal(evaluateEvolution(root, { ...opts, baseline: candidate, now: '2026-09-24T00:00:00Z' }).phase, 'rollback_required');
});
