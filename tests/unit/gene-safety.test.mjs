import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-gene-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = await import(`../../engine/gene.mjs?test=${randomUUID()}`);
  api.initGene(root);
  const dir = path.join(root, '工程/经验库');
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { root, dir, read, api };
}

function evidence(dir) {
  const content = 'User confirmed the observed behavior in this isolated fixture.';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-source.txt'), content);
  return [`source-file:工程/经验库/review-source.txt sha256:${createHash('sha256').update(content).digest('hex')}`];
}

test('reading state or a created proposal never returns mutable engine references', async t => {
  const { api } = await fixture(t);
  api.getGenome().genes.humor.baseline = 0.9;
  api.updateGenes([], { sessionId: 's', message: 'neutral' });
  assert.equal(api.getGenome().genes.humor.baseline, 0.53);
  const p = api.proposeBaselineChange('humor', 0.6, 'test', ['auto_drift']);
  p.status = 'approved';
  assert.equal(api.getGenome().proposals[0].status, 'pending');
});

test('independent writers merge against current disk state rather than overwrite it', async t => {
  const { root, api, read } = await fixture(t);
  const second = await import(`../../engine/gene.mjs?test=${randomUUID()}`);
  second.initGene(root);
  const a = api.proposeBaselineChange('humor', 0.6, 'a', ['auto_drift']);
  const b = second.proposeBaselineChange('curiosity', 0.85, 'b', ['auto_drift']);
  assert.deepEqual(read('proposals.json').proposals.map(p => p.proposal_id), [a.proposal_id, b.proposal_id]);
});

test('proposal persistence failure is reported and does not contaminate memory', async t => {
  const { api, dir } = await fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(dir, 'proposals.json')) throw new Error('injected disk failure');
    return rename(from, to);
  });
  const result = api.proposeBaselineChange('humor', 0.6, 'test', ['auto_drift']);
  assert.ok(result?.error);
  t.mock.restoreAll();
  assert.equal(api.getGenome().proposals.length, 0);
});

test('corrupted stored state fails closed without replacing it with defaults', async t => {
  const { root, dir, api } = await fixture(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'genome.json'), '{broken');
  assert.throws(() => api.initGene(root));
  assert.equal(fs.readFileSync(path.join(dir, 'genome.json'), 'utf8'), '{broken');
});

for (const name of ['genome.json', 'proposals.json']) test(`approval failure writing ${name} restores BOTH files and memory`, async t => {
  const { api, dir, read } = await fixture(t);
  const p = api.proposeBaselineChange('humor', 0.6, 'test', evidence(dir));
  const before = api.getGenome();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(dir, name)) throw new Error('injected disk failure');
    return rename(from, to);
  });
  const result = api.approveProposal(p.proposal_id, 'tester');
  assert.ok(result.error);
  t.mock.restoreAll();
  assert.deepEqual(api.getGenome(), before);
  assert.equal(read('proposals.json').proposals[0].status, 'pending');
  assert.equal(read('genome.json').genes.humor.baseline, 0.53);
});

test('a leftover transaction is recovered before readers expose partially applied state', async t => {
  const { root, api, dir, read } = await fixture(t);
  api.proposeBaselineChange('humor', 0.6, 'test', evidence(dir));
  const before = ['genome.json', 'proposals.json'].map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
  fs.writeFileSync(path.join(dir, '.gene-transaction.json'), JSON.stringify({ version: 1, before }));
  const damaged = read('genome.json'); damaged.genes.humor.baseline = 0.9;
  fs.writeFileSync(path.join(dir, 'genome.json'), JSON.stringify(damaged));
  api.initGene(root);
  assert.equal(api.getGenome().genes.humor.baseline, 0.53);
  assert.equal(fs.existsSync(path.join(dir, '.gene-transaction.json')), false);
});

test('observations never rewrite unrelated legacy proposal bytes', async t => {
  const { api, dir } = await fixture(t);
  const file = path.join(dir, 'proposals.json');
  const original = JSON.stringify({ proposals: [], reviews: [], snapshots: [] }) + '\n';
  fs.writeFileSync(file, original);
  api.updateGenes(['task_deep'], { sessionId: 's', turnId: 'one', message: 'research' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('an existing writer lock is never stolen or removed', async t => {
  const { api, dir } = await fixture(t);
  const file = path.join(dir, '.gene-writer.lock');
  const original = JSON.stringify({ pid: process.pid });
  fs.writeFileSync(file, original);
  assert.ok(api.proposeBaselineChange('humor', 0.6, 'test', ['auto_drift']).error);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});
