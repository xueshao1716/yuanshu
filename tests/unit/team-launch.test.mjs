import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createTeamLauncher } from '../../engine/team-launch.mjs';

function fixture(t, overrides = {}) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  const calls = [];
  const child = new EventEmitter();
  child.pid = process.pid;
  child.unref = () => {};
  const options = { wsRoot, repoRoot: path.resolve('.'), port: 18991, token: 'fixture-secret',
    spawnProcess: (...args) => { calls.push(args); return child; }, ...overrides };
  const launcher = createTeamLauncher(options);
  const write = (name, value) => {
    const file = path.join(wsRoot, '记忆/运行时', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { wsRoot, calls, child, launcher, options, write };
}

test('stop requests are scoped to the current launch and are durable', async t => {
  const f = fixture(t);
  const pending = f.launcher.start('test stop');
  f.child.emit('spawn');
  const { body } = await pending;
  assert.equal(f.launcher.stop('wrong-id').status, 409);
  assert.equal(f.launcher.stop(body.launch.id).status, 200);
  assert.equal(f.launcher.status().status, 'stopping');
  assert.ok(fs.existsSync(path.join(f.wsRoot, `记忆/运行时/team-stop-${body.launch.id}.json`)));
  f.child.emit('exit', 1, null);
  assert.equal(f.launcher.status().status, 'stopped');
});

test('resume starts a new launch with the existing checkpoint id', async t => {
  const f = fixture(t);
  const pending = f.launcher.start('resume task');
  f.child.emit('spawn');
  const first = (await pending).body.launch;
  f.child.emit('exit', 1, null);
  const resumed = f.launcher.resume(first.id);
  f.child.emit('spawn');
  const result = await resumed;
  assert.equal(result.status, 200);
  assert.notEqual(result.body.launch.id, first.id);
  assert.equal(f.calls[1][2].env.YUANSHU_TEAM_RESUME_ID, first.id);
  f.child.emit('exit', 1, null);
});

test('exclusive claim rejects concurrent launchers before spawn confirmation', async t => {
  const f = fixture(t);
  const first = f.launcher.start('视频任务');
  assert.equal(f.launcher.status().status, 'launching');
  assert.equal(createTeamLauncher(f.options).status().status, 'launching');
  assert.equal((await createTeamLauncher(f.options).start('重复')).status, 409);
  assert.equal(f.calls.length, 1);
  f.child.emit('spawn');
  const result = await first;
  assert.equal(result.status, 200);
  assert.equal(result.body.launch.status, 'running');
  const [command, args, options] = f.calls[0];
  assert.equal(command, process.execPath);
  assert.equal(args[0], path.resolve('scripts/team-run-live.mjs'));
  assert.equal(options.cwd, f.wsRoot);
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, false);
  assert.equal(options.env.YUANSHU_CWD, f.wsRoot);
  assert.equal(options.env.YUANSHU_TEAM_BASE_URL, 'http://127.0.0.1:18991');
  assert.equal(options.env.YUANSHU_TOKEN, 'fixture-secret');
  assert.equal(options.env.YUANSHU_TEAM_LAUNCH_ID, result.body.launch.id);
  assert.ok(!JSON.stringify({ args, result, state: f.launcher.status() }).includes('fixture-secret'));
  f.child.emit('exit', 0, null);
  assert.equal(f.launcher.status().status, 'failed'); // zero exit without matching snapshot is not completion
});

test('async spawn failure is a failure response and permits retry', async t => {
  const f = fixture(t);
  const first = f.launcher.start('任务');
  f.child.emit('error', new Error('fixture-secret ENOENT'));
  assert.equal((await first).status, 500);
  assert.equal(f.launcher.status().status, 'failed');
  assert.ok(!JSON.stringify(f.launcher.status()).includes('fixture-secret'));
  const second = f.launcher.start('重试');
  f.child.emit('spawn');
  assert.equal((await second).status, 200);
  f.child.emit('exit', 1, null);
});

test('matching snapshot and successful exit mean execution completed, not delivery accepted', async t => {
  const f = fixture(t);
  const first = f.launcher.start('任务');
  f.child.emit('spawn');
  const result = await first;
  const file = path.join(f.wsRoot, '工程/多AI角色扮演系统/team-run.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ launchId: result.body.launch.id, delivery: { status: 'pending_review' } }));
  f.child.emit('exit', 0, null);
  assert.equal(f.launcher.status().status, 'completed');
  assert.equal(createTeamLauncher(f.options).status().status, 'completed');
});

for (const [label, lock] of [
  ['old but alive', { pid: process.pid, at: '2000-01-01T00:00:00Z' }],
  ['malformed', '{invalid'], ['missing pid', {}], ['null record', 'null'],
]) test(`legacy lock ${label} blocks launch`, async t => {
  const f = fixture(t);
  f.write('天团运行锁.json', lock);
  const pending = f.launcher.start('任务');
  if (f.calls.length) f.child.emit('error', new Error('unexpected launch'));
  assert.equal((await pending).status, 409);
  assert.equal(f.calls.length, 0);
});

test('abandoned claim is not guessed safe to erase', async t => {
  const f = fixture(t);
  f.write('天团启动锁.json', { id: 'old', status: 'launching', ownerPid: 2147483647 });
  assert.equal((await f.launcher.start('任务')).status, 409);
  assert.equal(f.calls.length, 0);
});

test('hardlinked lock fails closed and does not modify source', async t => {
  const f = fixture(t);
  const original = path.join(f.wsRoot, 'original.json');
  fs.writeFileSync(original, '{}');
  fs.mkdirSync(path.join(f.wsRoot, '记忆/运行时'), { recursive: true });
  fs.linkSync(original, path.join(f.wsRoot, '记忆/运行时/天团启动锁.json'));
  assert.equal((await f.launcher.start('任务')).status, 409);
  assert.equal(fs.readFileSync(original, 'utf8'), '{}');
  assert.equal(f.calls.length, 0);
});

test('invalid tasks never start a process', async t => {
  const f = fixture(t);
  for (const task of ['', '  ', {}, 'a'.repeat(301), 'bad\0task']) {
    assert.equal((await f.launcher.start(task)).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('status follows a newer launch from another server instance', async t => {
  const f = fixture(t);
  const first = f.launcher.start('旧任务');
  f.child.emit('spawn');
  await first;
  f.child.emit('exit', 1, null);
  const other = createTeamLauncher(f.options);
  const second = other.start('新任务');
  assert.equal(f.launcher.status().task, '新任务');
  f.child.emit('spawn');
  await second;
  f.child.emit('exit', 1, null);
});

test('real harmless process completes only with its matching snapshot', async t => {
  let exited;
  const f = fixture(t, { spawnProcess: (_command, _args, options) => {
    const code = `const fs=require('node:fs');const path=require('node:path');const p=path.join(process.env.YUANSHU_CWD,'工程/多AI角色扮演系统/team-run.json');fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify({launchId:process.env.YUANSHU_TEAM_LAUNCH_ID}));`;
    const child = spawn(process.execPath, ['-e', code], { ...options, detached: false });
    exited = new Promise(resolve => child.once('exit', resolve));
    return child;
  } });
  assert.equal((await f.launcher.start('无模型测试')).status, 200);
  await exited;
  assert.equal(f.launcher.status().status, 'completed');
});

test('real OS spawn error returns failure without exposing error details', async t => {
  const f = fixture(t, { spawnProcess: (_command, args, options) => spawn(path.join(os.tmpdir(), 'yuanshu-no-such-executable'), args, options) });
  const result = await f.launcher.start('无模型测试');
  assert.equal(result.status, 500);
  assert.equal(f.launcher.status().status, 'failed');
});
