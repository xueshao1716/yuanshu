import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-governance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = await import(`../../engine/gene.mjs?test=${randomUUID()}`);
  api.initGene(root);
  const file = path.join(root, 'review.txt');
  fs.writeFileSync(file, 'Isolated source reviewed by the test operator.');
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const evidence = [`source-file:review.txt sha256:${hash}`];
  const propose = (value = 0.6, refs = evidence) => api.proposeBaselineChange('humor', value, 'review', refs);
  return { root, file, api, evidence, propose };
}

for (const refs of [['human:yes'], ['gene-event:missing'], ['auto_drift']]) {
  test(`unresolvable evidence cannot approve: ${refs[0]}`, async t => {
    const { api, propose } = await fixture(t);
    const p = propose(0.6, refs);
    assert.ok(api.approveProposal(p.proposal_id, 'tester').error);
    assert.equal(api.getGenome().proposals[0].status, 'pending');
  });
}
test('source file is checked at approval, not just proposal creation', async t => {
  const { api, propose, file } = await fixture(t);
  const p = propose();
  fs.appendFileSync(file, ' changed');
  assert.ok(api.approveProposal(p.proposal_id, 'tester').error);
});
test('verified source can approve but mixed fabricated evidence cannot', async t => {
  const { api, propose, evidence } = await fixture(t);
  const bad = propose(0.61, [...evidence, 'made up']);
  assert.ok(api.approveProposal(bad.proposal_id, 'tester').error);
  assert.equal(api.approveProposal(propose().proposal_id, 'tester').approved, true);
});
test('source paths cannot escape workspace, including junctions', async t => {
  const { root, file, api, propose } = await fixture(t);
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const source of [file, '../review.txt', '.token']) {
    assert.ok(api.approveProposal(propose(0.6, [`source-file:${source} sha256:${hash}`]).proposal_id).error);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.copyFileSync(file, path.join(outside, 'review.txt'));
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
  assert.ok(api.approveProposal(propose(0.6, [`source-file:linked/review.txt sha256:${hash}`]).proposal_id).error);
});
test('rollback requires attribution and cannot overwrite a newer baseline', async t => {
  const { api, propose } = await fixture(t);
  const first = api.approveProposal(propose().proposal_id, 'tester');
  assert.ok(api.rollbackSnapshot(first.snapshot_id).error);
  api.approveProposal(propose(0.7).proposal_id, 'tester');
  assert.ok(api.rollbackSnapshot(first.snapshot_id, 'tester', 'undo').error);
  assert.equal(api.getGenome().genes.humor.baseline, 0.7);
});
test('rollback records a review, reconciles proposal and is single use', async t => {
  const { api, propose } = await fixture(t);
  const p = propose();
  const approved = api.approveProposal(p.proposal_id, 'tester');
  assert.equal(api.rollbackSnapshot(approved.snapshot_id, 'tester', 'undo').ok, true);
  const state = api.getGenome();
  assert.equal(state.proposals[0].status, 'rolled_back');
  assert.equal(state.reviews.at(-1).decision, 'rolled_back');
  assert.equal(state.reviews.at(-1).reason, 'undo');
  assert.ok(api.rollbackSnapshot(approved.snapshot_id, 'tester', 'again').error);
});
test('ABA baseline values do not revive an old snapshot', async t => {
  const { api, propose } = await fixture(t);
  const first = api.approveProposal(propose().proposal_id, 'tester');
  api.approveProposal(propose(0.7).proposal_id, 'tester');
  api.approveProposal(propose(0.6).proposal_id, 'tester');
  assert.ok(api.rollbackSnapshot(first.snapshot_id, 'tester', 'old').error);
  assert.equal(api.getGenome().genes.humor.baseline, 0.6);
});

test('automatic evidence resolves real events, rejects tampering and duplicate samples', async t => {
  const { api, root } = await fixture(t);
  const file = path.join(root, '工程/经验库/genome.json');
  const genes = api.getGenome().genes;
  genes.gentleness.expression = 0.99;
  fs.writeFileSync(file, JSON.stringify({ genes }));
  api.initGene(root);
  const now = Date.now();
  for (const [i, offset] of [86400000, 43200000, 0].entries()) api.updateGenes(['user_frustrated'], { now: now - offset, sessionId: 's', message: 'frustrated', turnId: String(i) });
  const generated = api.autoProposeFromDrift({ now })[0];
  assert.ok(generated);
  const duplicate = api.proposeBaselineChange('gentleness', 0.85, 'invalid duplicate samples', [generated.evidence[0], generated.evidence[2], generated.evidence[2]]);
  assert.ok(api.approveProposal(duplicate.proposal_id, 'tester').error);
  const tampered = api.proposeBaselineChange('gentleness', 0.85, 'tampered', generated.evidence.map(e => e.replace('session:s ', 'session:forged ')));
  assert.ok(api.approveProposal(tampered.proposal_id, 'tester').error);
  assert.equal(api.approveProposal(generated.proposal_id, 'tester').approved, true);
});

test('approval refuses stale confirmations inside the disk transaction', async t => {
  const { api, propose } = await fixture(t);
  const p = propose();
  const expected = { item: { ...p, reason: 'other' }, baseline: 0.53, revision: null };
  assert.ok(api.approveProposal(p.proposal_id, 'tester', expected).error);
  assert.equal(api.getGenome().genes.humor.baseline, 0.53);
});

test('new observations do not invalidate an already qualified pending evidence span', async t => {
  const { api, root } = await fixture(t);
  const file = path.join(root, '工程/经验库/genome.json');
  const genes = api.getGenome().genes;
  genes.gentleness.expression = 0.99;
  fs.writeFileSync(file, JSON.stringify({ genes }));
  api.initGene(root);
  const now = Date.now() - 1000;
  for (const [i, offset] of [86400000, 43200000, 0].entries()) api.updateGenes(['user_frustrated'], { now: now - offset, sessionId: 's', message: 'frustrated', turnId: String(i) });
  const p = api.autoProposeFromDrift({ now })[0];
  api.updateGenes(['user_frustrated'], { sessionId: 's', message: 'new feedback', turnId: 'next' });
  assert.equal(api.approveProposal(p.proposal_id, 'tester').approved, true);
});
