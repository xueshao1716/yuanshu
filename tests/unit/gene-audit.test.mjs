import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initGene, updateGenes, getGenome, autoProposeFromDrift, proposeBaselineChange, approveProposal, rollbackSnapshot, geneSnapshot } from '../../engine/gene.mjs';
import { init, updateEmotion } from '../../engine/emotion.mjs';
import { seedExpression, sourceEvidence } from '../helpers/gene-fixture.mjs';

const epoch = Date.parse('2026-09-01T00:00:00Z');
const day = 86400000;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-gene-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initGene(root);
  return root;
}
function observe(now, tags = ['user_frustrated']) {
  updateGenes(tags, { now, sessionId: 'audit-session', message: 'private test message' });
}

test('small intended changes survive persistence and restart', t => {
  const root = fixture(t);
  observe(epoch, ['user_happy', 'alert_risk', 'task_accomplish']);
  initGene(root);
  assert.ok(getGenome().genes.gentleness.expression > 0.8);
  assert.ok(getGenome().genes.caution.expression > 0.4);
  assert.ok(getGenome().genes.initiative.expression > 0.45);
});
test('expression can reach its boundary without floating-point dead zone', t => {
  const root = fixture(t);
  seedExpression(root, 'gentleness', 0.9980000000000002);
  observe(epoch);
  assert.equal(getGenome().genes.gentleness.expression, 1);
});
test('idle expression returns gradually to baseline without changing baseline', t => {
  const root = fixture(t);
  seedExpression(root, 'gentleness', 1);
  observe(epoch, []);
  initGene(root);
  observe(epoch + 7 * day, []);
  assert.ok(Math.abs(getGenome().genes.gentleness.expression - 0.9) < 0.000001);
  assert.equal(getGenome().genes.gentleness.baseline, 0.8);
});
test('a lone drift value cannot manufacture sustained evidence', t => {
  const root = fixture(t);
  seedExpression(root, 'gentleness', 1);
  assert.deepEqual(autoProposeFromDrift({ now: epoch }), []);
});
test('sustained sourced observations create one pending proposal, surviving restart', t => {
  const root = fixture(t);
  seedExpression(root, 'gentleness', 0.99);
  for (const offset of [0, day / 2, day]) observe(epoch + offset);
  initGene(root);
  const proposals = autoProposeFromDrift({ now: epoch + day });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'pending');
  assert.ok(proposals[0].evidence.length >= 3);
  assert.ok(proposals[0].evidence.every(e => e.includes('gene-event:') && e.includes('audit-session')));
  assert.equal(getGenome().genes.gentleness.baseline, 0.8);
  assert.deepEqual(autoProposeFromDrift({ now: epoch + day }), []);
  const raw = fs.readFileSync(path.join(root, '工程/经验库/genome.json'), 'utf8');
  assert.ok(!raw.includes('private test message'));
});
test('rapid bursts and expired evidence do not prove sustained drift', t => {
  const root = fixture(t);
  seedExpression(root, 'gentleness', 0.99);
  for (const offset of [0, 1, 2]) observe(epoch + offset);
  assert.deepEqual(autoProposeFromDrift({ now: epoch + 2 }), []);
  observe(epoch + day);
  assert.deepEqual(autoProposeFromDrift({ now: epoch + 32 * day }), []);
});
test('eval conversations never change the real genome or evidence', t => {
  const root = fixture(t);
  init(root);
  const before = JSON.stringify(getGenome());
  updateEmotion('eval-gene-audit', '烦死了，这是什么破东西');
  assert.equal(JSON.stringify(getGenome()), before);
});
test('invalid targets are rejected and legacy evidence stays pending', t => {
  fixture(t);
  for (const value of [NaN, Infinity, -0.1, 1.1, '0.9']) {
    assert.equal(proposeBaselineChange('gentleness', value, 'test', ['manual']), null);
  }
  const p = proposeBaselineChange('gentleness', 0.86, 'legacy', ['auto_drift']);
  assert.ok(approveProposal(p.proposal_id).error);
  assert.equal(p.status, 'pending');
  assert.equal(getGenome().genes.gentleness.baseline, 0.8);
});
test('rollback restores original expression rather than flattening it to baseline', t => {
  const root = fixture(t);
  seedExpression(root, 'humor', 0.63);
  const p = proposeBaselineChange('humor', 0.6, 'human reviewed', sourceEvidence(root));
  const result = approveProposal(p.proposal_id);
  assert.equal(result.approved, true);
  assert.equal(rollbackSnapshot(result.snapshot_id, 'tester', 'undo').ok, true);
  assert.equal(getGenome().genes.humor.expression, 0.63);
});
test('zero expression is displayed as zero', t => {
  const root = fixture(t);
  seedExpression(root, 'humor', 0);
  assert.equal(geneSnapshot().humor, 0);
});

test('legacy pending proposals survive initialization unchanged without invented evidence', t => {
  const root = fixture(t);
  for (const name of ['gentleness', 'curiosity', 'learning', 'creativity', 'humor']) {
    proposeBaselineChange(name, getGenome().genes[name].baseline + 0.03, 'legacy', ['auto_drift']);
  }
  const file = path.join(root, '工程/经验库/proposals.json');
  const before = fs.readFileSync(file, 'utf8');
  initGene(root);
  assert.deepEqual(autoProposeFromDrift({ now: epoch }), []);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(getGenome().proposals.filter(p => p.status === 'pending').length, 5);
});

test('a stale proposal cannot overwrite a newly reviewed baseline', t => {
  const root = fixture(t);
  const old = proposeBaselineChange('humor', 0.6, 'first', sourceEvidence(root));
  const newer = proposeBaselineChange('humor', 0.65, 'second', sourceEvidence(root));
  assert.equal(approveProposal(newer.proposal_id).approved, true);
  assert.match(approveProposal(old.proposal_id).error, /过期/);
  assert.equal(old.status, 'pending');
  assert.equal(getGenome().genes.humor.baseline, 0.65);
});
