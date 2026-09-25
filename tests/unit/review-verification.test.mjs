import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewVerification } from '../../engine/review-verification.mjs';

test('verification expires when CI configuration changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createReviewVerification({ root });
  store.save({ digest: store.fingerprint(), checks: ['unit', 'types', 'build'].map(name => ({ name, state: 'passed' })) });
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/verify.yml'), 'changed');
  assert.equal(store.read().state, 'stale');
});

test('verification is bound to source bytes and reports edits as stale', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'engine'));
  fs.writeFileSync(path.join(root, 'engine/a.mjs'), 'before');
  const store = createReviewVerification({ root });
  assert.deepEqual(store.read(), { state: 'unknown', checks: [] });
  const digest = store.fingerprint();
  store.save({ digest, checks: ['unit', 'types', 'build'].map(name => ({ name, state: 'passed' })), state: 'passed' });
  assert.equal(store.read().state, 'passed');
  fs.writeFileSync(path.join(root, 'engine/a.mjs'), 'after');
  assert.equal(store.read().state, 'stale');
  assert.equal(store.read().checks[0].state, 'passed');
});

test('verification fails closed for missing required checks and edits during a run', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createReviewVerification({ root });
  const digest = store.fingerprint();
  store.save({ digest, checks: [], state: 'passed' });
  assert.equal(store.read().state, 'unknown');
  store.save({ digest, checks: [{ name: 'unit', state: 'passed' }] });
  assert.equal(store.read().state, 'unknown');
  store.save({ digest, checks: [{ name: 'unit', state: 'failed' }], state: 'passed' });
  assert.equal(store.read().state, 'failed');
});

test('verification expires after frontend style build configuration changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'frontend'));
  const config = path.join(root, 'frontend/uno.config.ts');
  fs.writeFileSync(config, 'before');
  const store = createReviewVerification({ root });
  store.save({ digest: store.fingerprint(), checks: ['unit', 'types', 'build'].map(name => ({ name, state: 'passed' })) });
  assert.equal(store.read().state, 'passed');
  fs.writeFileSync(config, 'after');
  assert.equal(store.read().state, 'stale');
});

test('verification expires when a skill is added or edited', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createReviewVerification({ root });
  const save = () => store.save({ digest: store.fingerprint(), checks: ['unit', 'types', 'build'].map(name => ({ name, state: 'passed' })) });
  save();
  const dir = path.join(root, 'skills', 'new-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'before');
  assert.equal(store.read().state, 'stale');
  save();
  assert.equal(store.read().state, 'passed');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'after');
  assert.equal(store.read().state, 'stale');
});
