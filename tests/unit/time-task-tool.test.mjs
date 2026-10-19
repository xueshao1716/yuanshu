import test from 'node:test';
import assert from 'node:assert/strict';
import {TIME_TASK_SCHEMA, createUnifiedToolExecutorGuarded} from '../../engine/tools/unified-tools.mjs';

// 2026-10-20：模型侧必须"看得见"时间引擎，否则她会对外声称自己没有后台能力。
test('time_task schema 暴露给模型，且描述里明确"有后台能力"', () => {
  assert.equal(TIME_TASK_SCHEMA?.function?.name, 'time_task');
  assert.deepEqual(TIME_TASK_SCHEMA.function.parameters.properties.action.enum,
    ['list', 'register', 'pause', 'resume', 'run', 'remove']);
  assert.match(TIME_TASK_SCHEMA.function.description, /后台/);
});

function fixture() {
  const calls = [];
  const engine = {
    list: () => [{id: 'a1', type: 'daily', at: '09:00', prompt: '推进小秤训练', runs: 3}],
    register: (body) => { calls.push(['register', body]); return {id: 'new1'}; },
    remove: (id) => ({removed: id === 'a1'}),
    pause: (id) => ({ok: true, id}), resume: (id) => ({ok: true, id}),
    runNow: async (id) => ({ok: true, id}),
  };
  const exec = createUnifiedToolExecutorGuarded({
    getCwd: () => process.cwd(),
    safePath: (p) => p,
    timeEngine: () => engine,
  });
  return {exec, calls, engine};
}

test('time_task: list / register / pause / resume / run / remove 都能走通', async () => {
  const f = fixture();
  const list = await f.exec('time_task', {action: 'list'});
  assert.match(list.text, /推进小秤训练/);

  const reg = await f.exec('time_task', {action: 'register', type: 'daily', at: '09:00', prompt: '每天检查小秤的作业并批阅', label: '每日推进'});
  assert.match(reg.text, /已注册/);
  assert.equal(f.calls.at(-1)[1].prompt, '每天检查小秤的作业并批阅');
  assert.equal(f.calls.at(-1)[1].notify, true);

  assert.match((await f.exec('time_task', {action: 'pause', id: 'a1'})).text, /已暂停/);
  assert.match((await f.exec('time_task', {action: 'resume', id: 'a1'})).text, /已恢复/);
  assert.match((await f.exec('time_task', {action: 'run', id: 'a1'})).text, /已立刻执行/);
  assert.match((await f.exec('time_task', {action: 'remove', id: 'a1'})).text, /已删除/);
});

test('time_task: 缺 prompt / 未知 action 都给出可纠正的错误', async () => {
  const f = fixture();
  const noPrompt = await f.exec('time_task', {action: 'register', type: 'daily', at: '09:00'});
  assert.equal(noPrompt.isError, true);
  assert.match(noPrompt.text, /需要 prompt/);

  const bad = await f.exec('time_task', {action: 'explode'});
  assert.equal(bad.isError, true);
  assert.match(bad.text, /未知 action/);
});
