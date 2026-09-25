import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as runner from '../../scripts/verification-runner.mjs';
import { createReviewVerification } from '../../engine/review-verification.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-runner-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('verification environment redirects workspace and agent state without inheriting credentials', () => {
  const env = runner.verificationEnvironment('/isolated', { Path: '/bin', USERPROFILE: '/real-user', HOME: '/real-user', OPENAI_API_KEY: 'secret', SOME_PROVIDER_TOKEN: 'secret', NODE_OPTIONS: '--import=untrusted', YUANSHU_CWD: '/live' });
  assert.equal(env.Path, '/bin');
  assert.equal(env.USERPROFILE, '/real-user');
  assert.equal(env.HOME, '/real-user');
  assert.equal(env.YUANSHU_CWD, path.join('/isolated', 'workspace'));
  assert.equal(env.PI_WEB_CWD, env.YUANSHU_CWD);
  assert.equal(env.PI_WORKSPACE, env.YUANSHU_CWD);
  assert.equal(env.YUANSHU_AGENT_DIR, path.join('/isolated', 'agent'));
  for (const key of ['OPENAI_API_KEY', 'SOME_PROVIDER_TOKEN', 'NODE_OPTIONS']) assert.equal(env[key], undefined);
});

test('verification steps include preload and build only to verification output', t => {
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'tests/unit'), { recursive: true });
  for (const name of ['b.test.mjs', 'a.test.mjs', 'ignore.mjs']) fs.writeFileSync(path.join(root, 'tests/unit', name), '');
  const steps = runner.verificationSteps(root, path.join(root, 'tmp'));
  assert.deepEqual(steps.map(s => s.name), ['unit', 'types', 'build']);
  assert.ok(steps[0].args.includes('--import'));
  assert.deepEqual(steps[0].args.slice(-2), ['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs']);
  assert.equal(steps[2].args.at(-1), path.join(root, 'tmp/verification-dist'));
  assert.ok(!steps[2].args.includes(path.join(root, 'frontend/dist')));
});

test('skill inventory distinguishes tracked, local and incomplete directories without excluding them', t => {
  const root = temp(t);
  execFileSync('git', ['init', '-q', root]);
  for (const name of ['bundled', 'local', 'incomplete']) fs.mkdirSync(path.join(root, 'skills', name), { recursive: true });
  for (const name of ['bundled', 'local']) fs.writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), '# test');
  execFileSync('git', ['add', 'skills/bundled/SKILL.md'], { cwd: root });
  assert.deepEqual(runner.skillInventory(root), { tracked: ['bundled'], local: ['local'], missing: ['incomplete'] });
});

test('a failed command remains failed while later checks still produce evidence', t => {
  const root = temp(t);
  const store = createReviewVerification({ root });
  const logDir = path.join(root, 'tmp');
  fs.mkdirSync(logDir);
  const steps = ['unit', 'types', 'build'].map(name => ({ name, cwd: root, args: ['-e', `console.log('${name}'); process.exit(${name === 'unit' ? 7 : 0})`] }));
  assert.equal(runner.runVerificationChecks({ steps, env: process.env, store, digest: store.fingerprint(), logDir }), 1);
  const record = store.read();
  assert.equal(record.state, 'failed');
  assert.deepEqual(record.checks.map(c => c.exitCode), [7, 0, 0]);
  assert.match(fs.readFileSync(path.join(logDir, 'verification-unit.log'), 'utf8'), /unit/);
});

test('spawn failures are recorded instead of leaving verification running', t => {
  const root = temp(t);
  const logDir = path.join(root, 'tmp'); fs.mkdirSync(logDir);
  const store = createReviewVerification({ root });
  const spawn = () => { throw Object.assign(new Error('cannot launch'), { code: 'ENOENT' }); };
  assert.equal(runner.runVerificationChecks({ steps: [{ name: 'unit', cwd: root, args: [] }], env: {}, store, digest: store.fingerprint(), logDir, spawn }), 1);
  assert.equal(store.read().state, 'failed');
  assert.match(fs.readFileSync(path.join(logDir, 'verification-unit.log'), 'utf8'), /ENOENT/);
});
