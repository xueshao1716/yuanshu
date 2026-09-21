import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTeamCheckpoint } from '../../engine/team-checkpoint.mjs';

test('successful stages replay without another call; budget persists across restarts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls = 0;
  const options = { wsRoot: root, id: 'run-one', task: 'task', maxCalls: 1 };
  const first = createTeamCheckpoint(options);
  const work = async () => { calls++; return { ok: true, text: 'result' }; };
  await first.step('A', 'input', work);
  const resumed = createTeamCheckpoint(options);
  assert.ok(first.snapshot().createdAt);
  assert.equal(resumed.snapshot().createdAt, first.snapshot().createdAt);
  assert.deepEqual(await resumed.step('A', 'input', work), { ok: true, text: 'result' });
  assert.equal(calls, 1);
  await assert.rejects(resumed.step('B', 'input', work), /budget/);
  assert.throws(() => createTeamCheckpoint({ ...options, task: 'changed' }), /mismatch/);
});

test('checkpoint rejects malformed budgets', () => {
  assert.throws(() => createTeamCheckpoint({ wsRoot: os.tmpdir(), id: 'invalid-budget', task: 'x', maxCalls: -1 }), /budget/);
});

test('uncertain in-flight stages are never silently replayed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { wsRoot: root, id: 'run-two', task: 'task' };
  const first = createTeamCheckpoint(options);
  await assert.rejects(first.step('A', 'input', async () => { throw new Error('network uncertain'); }));
  await assert.rejects(createTeamCheckpoint(options).step('A', 'input', async () => 'bad'), /uncertain/);
});
