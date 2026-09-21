import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createTeamLauncher } from '../../engine/team-launch.mjs';
import { createRunStore } from '../../engine/run-store.mjs';
const mod = await import('../../engine/team-chat.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {}; });

test('launcher binds child to the same session/run and retains binding on resume', async t => {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-shared-'));
  t.after(() => fs.rmSync(wsRoot, { recursive: true, force: true }));
  let opts;
  const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {};
  const launcher = createTeamLauncher({ wsRoot, repoRoot: process.cwd(), port: 1234, token: 'secret',
    spawnProcess: (_exe, _args, options) => { opts = options; return child; } });
  const binding = { runId: 'run-1', sessionId: 'session-1', context: '只用青色背景', directive: '保持身份边界' };
  const pending = launcher.start('测试视频', null, binding);
  child.emit('spawn');
  const first = (await pending).body.launch;
  assert.equal(first.runId, 'run-1');
  assert.equal(first.sessionId, 'session-1');
  assert.equal(opts.env.YUANSHU_TEAM_CONTEXT, binding.context);
  assert.ok(!JSON.stringify(first).includes(binding.context));
  child.emit('exit', 1, null);
  const again = launcher.resume(first.id); child.emit('spawn');
  assert.equal((await again).body.launch.runId, 'run-1');
  assert.equal(opts.env.YUANSHU_TEAM_CONTEXT, binding.context);
  child.emit('exit', 1, null);
});

test('shared workflow and its checkpoint survive durable run recovery', t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-store-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = createRunStore({ rootDir });
  const run = store.create({ sessionId: 's', clientRequestId: 'c', message: '视频', workflow: 'team-video' });
  store.saveCheckpoint(run.id, { team: { launchId: 'launch', context: '背景约束' } });
  const reopened = createRunStore({ rootDir }).get(run.id);
  assert.equal(reopened.request.workflow, 'team-video');
  assert.equal(reopened.checkpoint.team.launchId, 'launch');
});

test('chat routing is explicit and scoped context excludes tools and older conversation', () => {
  assert.equal(typeof mod.isTeamRequest, 'function');
  assert.equal(mod.isTeamRequest({ message: '/team 写一个视频脚本' }), true);
  assert.equal(mod.isTeamRequest({ message: '解释一下天团' }), false);
  const context = mod.teamContext([
    { role: 'user', content: '旧任务秘密' }, { role: 'assistant', content: '旧回复' },
    { role: 'toolResult', content: 'secret tool output' },
    { role: 'user', content: '青色背景' }, { role: 'assistant', content: '三镜脚本' },
  ]);
  assert.ok(context.includes('青色背景'));
  assert.ok(!context.includes('secret tool output'));
  assert.ok(!context.includes('旧任务秘密'));
});

test('draft reader rejects workspace files outside the exact run draft before reading', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-team-draft-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(typeof mod.readTeamDraft, 'function');
  const snapshot = { runId: 'live-video-safe', delivery: { draft: '记忆/private.md' } };
  assert.throws(() => mod.readTeamDraft(root, snapshot), /草稿路径/);
  snapshot.delivery.draft = '工程/多AI角色扮演系统/runs/live-video-safe/草稿/终稿.md';
  const file = path.join(root, snapshot.delivery.draft);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '合法草稿');
  assert.equal(mod.readTeamDraft(root, snapshot), '合法草稿');
  snapshot.runId = '../private';
  assert.throws(() => mod.readTeamDraft(root, snapshot), /草稿路径/);
});
