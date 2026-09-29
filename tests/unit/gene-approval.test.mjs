import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../../engine/tools/confirm-registry.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

async function fixture(t) {
  const { createGeneApproval } = await import('../../engine/gene-approval.mjs');
  let applied = 0;
  const state = { genes: { humor: { baseline: 0.53 } }, proposals: [{ proposal_id: 'p', gene: 'humor', status: 'pending', evidence: ['test'] }], snapshots: [] };
  const api = { getGenome: () => structuredClone(state), approveProposal: (id, reviewer) => { applied++; return { approved: true, reviewer }; } };
  const requests = [];
  const request = createGeneApproval({ api, registry, sessionExists: sid => sid === 's', push: (...args) => requests.push(args), timeoutMs: 30 });
  t.after(() => registry.cancelAll('s'));
  return { request, requests, state, applied: () => applied };
}
test('self asserted reviewer cannot bypass a single use confirmation', async t => {
  const f = await fixture(t);
  assert.ok((await f.request('approve', { proposal_id: 'p', reviewer: 'human' })).error);
  const pending = f.request('approve', { proposal_id: 'p', sessionId: 's', reviewer: 'human' });
  assert.equal(f.applied(), 0);
  const item = registry.list().find(r => r.sessionId === 's');
  assert.equal(item.toolName, 'gene-governance');
  registry.settle('s', item.id, true);
  const result = await pending;
  assert.equal(result.approved, true);
  assert.match(result.reviewer, /^human-confirm:/);
  assert.equal(registry.settle('s', item.id, true).ok, false);
  assert.equal(f.applied(), 1);
});
test('reject, expiry and changed targets all fail closed', async t => {
  const f = await fixture(t);
  for (const outcome of ['reject', 'changed', 'expiry']) {
    const pending = f.request('approve', { proposal_id: 'p', sessionId: 's' });
    const item = registry.list().find(r => r.sessionId === 's');
    if (outcome === 'changed') f.state.proposals[0].evidence.push('modified');
    if (outcome === 'expiry') await new Promise(resolve => setTimeout(resolve, 50));
    else registry.settle('s', item.id, outcome === 'changed');
    assert.ok((await pending).error);
  }
  assert.equal(f.applied(), 0);
});

test('confirmation applies and rolls back real persisted state with attributed reviews', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-gene-confirm-'));
  t.after(() => { registry.cancelAll('local'); fs.rmSync(root, { recursive: true, force: true }); });
  const api = await import(`../../engine/gene.mjs?confirmation=${randomUUID()}`);
  const { createGeneApproval } = await import('../../engine/gene-approval.mjs');
  api.initGene(root);
  const source = 'Isolated review: user explicitly evaluated the proposed behavior.';
  fs.writeFileSync(path.join(root, 'review.txt'), source);
  const p = api.proposeBaselineChange('humor', 0.6, 'reviewed', [`source-file:review.txt sha256:${createHash('sha256').update(source).digest('hex')}`]);
  const cards = [];
  const request = createGeneApproval({ api, registry, sessionExists: id => id === 'local', push: (...args) => cards.push(args), timeoutMs: 1000 });
  const approve = request('approve', { sessionId: 'local', proposal_id: p.proposal_id, reviewer: 'forged' });
  assert.equal(api.getGenome().genes.humor.baseline, 0.53);
  assert.ok((await request('approve', { sessionId: 'local', proposal_id: p.proposal_id })).error);
  assert.equal(cards.length, 1);
  registry.settle('local', cards[0][2].id, true);
  const result = await approve;
  assert.equal(result.approved, true);
  api.initGene(root);
  assert.equal(api.getGenome().genes.humor.baseline, 0.6);
  const rollback = request('rollback', { sessionId: 'local', snapshot_id: result.snapshot_id, reason: 'Revert isolated trial' });
  assert.equal(api.getGenome().genes.humor.baseline, 0.6);
  registry.settle('local', cards[1][2].id, true);
  assert.equal((await rollback).ok, true);
  api.initGene(root);
  const state = api.getGenome();
  assert.equal(state.genes.humor.baseline, 0.53);
  assert.equal(state.proposals[0].status, 'rolled_back');
  assert.equal(state.reviews.length, 2);
  assert.ok(state.reviews.every(review => review.reviewer.startsWith('human-confirm:local:')));
  assert.equal(state.reviews[1].reason, 'Revert isolated trial');
});
