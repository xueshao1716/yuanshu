import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateEvolution, activateEvolution, readEvolution } from '../../engine/evolution-gate.mjs';

const baseline = { id: 'old', retryOnFailure: 2 };
const candidate = { id: 'new', retryOnFailure: 1 };
const historical = Array.from({ length: 8 }, (_, i) => ({ id: `h${i}`, group: `task${i}`,
  at: '2026-09-20T00:00:00Z', baseline: { score: 0, cost: 3, covered: true }, candidate: { score: 0, cost: 2, covered: true } }));
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const options = { domain: 'fix-attempt', baseline, candidate, rows: historical, now: '2026-09-21T00:00:00Z' };
const later = Array.from({ length: 3 }, (_, i) => ({ ...historical[i], id: `f${i}`, group: `fresh${i}`, at: '2026-09-22T00:00:00Z' }));

test('history only stages shadow, repeated task groups cannot satisfy holdout', t => {
  const root = setup(t);
  assert.equal(evaluateEvolution(root, { ...options, rows: historical.map(r => ({ ...r, group: 'same' })) }).phase, 'collecting');
  const s = evaluateEvolution(root, options);
  assert.equal(s.phase, 'shadow');
  assert.equal(s.holdout, 3);
  assert.equal(evaluateEvolution(root, options).phase, 'shadow');
});

test('new real groups qualify; enablement preserves exact rollback config; regression rolls back', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  const ready = evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  assert.equal(ready.phase, 'ready');
  let applied;
  await activateEvolution(root, { domain: 'fix-attempt', current: baseline, apply: async p => { applied = p; return { ok: true }; }, now: '2026-09-23T00:00:00Z' });
  assert.deepEqual(applied, candidate);
  const bad = { ...later[0], id: 'bad', group: 'new-bad', at: '2026-09-24T00:00:00Z', candidate: { score: 0, cost: 1, covered: false } };
  const s = evaluateEvolution(root, { ...options, baseline: candidate, rows: [bad], now: '2026-09-24T01:00:00Z' });
  assert.equal(s.phase, 'rollback_required');
  await activateEvolution(root, { domain: 'fix-attempt', current: candidate, apply: async p => { applied = p; return { ok: true }; } });
  assert.deepEqual(applied, baseline);
  assert.equal(readEvolution(root, 'fix-attempt').phase, 'rolled_back');
});

test('failed write and changed baseline never report enabled', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: { ...baseline, retryOnFailure: 3 }, apply: () => assert.fail() })).ok, false);
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: baseline, apply: async () => ({ ok: false }) })).ok, false);
  assert.equal(readEvolution(root, 'fix-attempt').phase, 'ready');
});

test('holdout regressions and unsupported branches block promotion', t => {
  const root = setup(t);
  const rows = historical.map((r, i) => i === 7 ? { ...r, candidate: { ...r.candidate, covered: false } } : r);
  assert.equal(evaluateEvolution(root, { ...options, rows }).phase, 'rejected');
});

test('future-dated observations cannot advance the gate', t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  assert.equal(evaluateEvolution(root, { ...options, rows: [...historical, ...later] }).phase, 'shadow');
});

test('manual rollback is bound to the exact enablement', async t => {
  const root = setup(t);
  evaluateEvolution(root, options);
  evaluateEvolution(root, { ...options, rows: [...historical, ...later], now: '2026-09-23T00:00:00Z' });
  const enabledAt = '2026-09-23T01:00:00Z';
  await activateEvolution(root, { domain: 'fix-attempt', current: baseline, now: enabledAt, apply: async () => ({ ok: true }) });
  assert.equal((await activateEvolution(root, { domain: 'fix-attempt', current: candidate,
    revokeAt: 'old-enablement', apply: () => assert.fail('stale revoke must not write') })).ok, false);
  let applied;
  const r = await activateEvolution(root, { domain: 'fix-attempt', current: candidate, revokeAt: new Date(enabledAt).toISOString(),
    apply: async p => { applied = p; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(r.phase, 'rolled_back');
  assert.deepEqual(applied, baseline);
});
