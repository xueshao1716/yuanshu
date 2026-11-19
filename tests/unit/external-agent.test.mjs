import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTERNAL_AGENT_FILE, claimExternalSlot, resolveExternalCwd, runExternalAgent, createDelegateExternal } from '../../engine/external-agent.mjs';

const tmpWs = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ext-agent-'));
const writeCfg = (ws, v) => { const f = path.join(ws, EXTERNAL_AGENT_FILE); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)) };

function fakeLoad({ result, install = { kind: 'available' }, tools = [], seen = {} } = {}) {
  return async (agent) => ({
    runtime: {
      installation: async () => install,
      session: async (inst, opts) => {
        seen.opts = opts; seen.sandbox = process.env.OAR_CODEX_SANDBOX;
        return {
          events: (cb) => { for (const t of tools) cb({ kind: 'tool_call_started', tool: t }) },
          dispose: async () => { seen.disposed = true },
        };
      },
    },
    promptAndWait: async (s, input, o) => { seen.input = input; seen.timeoutMs = o.timeoutMs; return result },
  });
}

test('默认关闭：没有配置文件就不派', async () => {
  const ws = tmpWs();
  const run = createDelegateExternal({ wsRoot: ws, run: async () => assert.fail('不该跑') });
  const r = await run({ agent: 'claude', task: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /没开启/);
});

test('每天上限：第 6 次拒绝，换一天重置', () => {
  const ws = tmpWs();
  writeCfg(ws, { enabled: true });
  const day1 = Date.parse('2026-11-19T10:00:00Z');
  for (let i = 1; i <= 5; i++) assert.equal(claimExternalSlot(ws, day1).used, i);
  const r = claimExternalSlot(ws, day1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quota');
  assert.equal(claimExternalSlot(ws, day1 + 86400_000).used, 1);
});

test('工作目录只能在工作区里', () => {
  const ws = tmpWs();
  fs.mkdirSync(path.join(ws, 'proj'));
  assert.equal(resolveExternalCwd(ws, ''), path.resolve(ws));
  assert.equal(resolveExternalCwd(ws, 'proj'), path.join(path.resolve(ws), 'proj'));
  assert.equal(resolveExternalCwd(ws, '../'), null);
  assert.equal(resolveExternalCwd(ws, 'C:/Windows'), null);
  assert.equal(resolveExternalCwd(ws, 'nope'), null);
});

test('越界子目录不消耗次数', async () => {
  const ws = tmpWs();
  writeCfg(ws, { enabled: true, dailyCap: 1 });
  const run = createDelegateExternal({ wsRoot: ws, run: async () => ({ text: 'ok', isError: false }) });
  assert.equal((await run({ agent: 'codex', task: 'x', subdir: '..' })).isError, true);
  assert.equal((await run({ agent: 'codex', task: 'x' })).isError, false);
});

test('完成：返回文字和工具次数，会话被释放', async () => {
  const seen = {};
  const r = await runExternalAgent({ agent: 'claude', task: '改个 bug', cwd: 'D:/w', load: fakeLoad({ result: { kind: 'ended', outcome: { kind: 'completed' }, text: '改好了' }, tools: ['edit', 'shell'], seen }) });
  assert.equal(r.isError, false);
  assert.match(r.text, /改好了/);
  assert.match(r.text, /2 次工具/);
  assert.equal(seen.opts.userConfiguration, 'exclude');
  assert.equal(seen.disposed, true);
});

test('Codex 用 workspace-write 沙箱，跑完恢复环境变量', async () => {
  const seen = {};
  const before = process.env.OAR_CODEX_SANDBOX;
  await runExternalAgent({ agent: 'codex', task: 't', cwd: 'D:/w', load: fakeLoad({ result: { kind: 'ended', outcome: { kind: 'completed' }, text: '' }, seen }) });
  assert.equal(seen.sandbox, 'workspace-write');
  assert.equal(process.env.OAR_CODEX_SANDBOX, before);
});

test('失败、超时、未安装都报错', async () => {
  const failed = await runExternalAgent({ agent: 'claude', task: 't', cwd: '.', load: fakeLoad({ result: { kind: 'ended', outcome: { kind: 'failed', failure: 'quota', reason: 'limit' }, text: '' } }) });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /额度用完/);
  const late = await runExternalAgent({ agent: 'claude', task: 't', cwd: '.', timeoutMs: 60_000, load: fakeLoad({ result: { kind: 'interrupted', by: 'timeout', text: '半截' } }) });
  assert.match(late.text, /超过 1 分钟/);
  const none = await runExternalAgent({ agent: 'codex', task: 't', cwd: '.', load: fakeLoad({ install: { kind: 'missing' } }) });
  assert.match(none.text, /没找到可用的 Codex/);
  const broken = await runExternalAgent({ agent: 'codex', task: 't', cwd: '.', load: async () => { throw new Error('no module') } });
  assert.match(broken.text, /没装好/);
});
