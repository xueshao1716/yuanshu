import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRunHistorySnapshot, restoreRunHistorySnapshot, initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { persistYuanshuToolTrace } from '../../engine/yuanshu-session.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

const task = { role: 'user', content: '收集并验证全部页面，不要重做已经完成的页' };
const exchange = n => [
  { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: `c${n}`, content: `page ${n} saved` },
];

test('long checkpoint retains current task and persists new resumed tool evidence', () => {
  const history = [{ role: 'system', content: '规则' }, task];
  for (let n = 1; n <= 10; n++) history.push(...exchange(n));
  const snapshot = createRunHistorySnapshot(history, { turn: 10 });
  const restored = restoreRunHistorySnapshot(snapshot);
  assert.ok(restored.some(m => m.role === 'user' && m.content === task.content));
  restored.push(...exchange(11));
  const rows = [];
  persistYuanshuToolTrace({ appendMessage: row => rows.push(row) }, restored, {
    toolCallIds: Array.from({ length: 10 }, (_, n) => `c${n + 1}`),
    toolResultIds: Array.from({ length: 10 }, (_, n) => `c${n + 1}`),
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].toolCallId, 'c11');
});

test('snapshot reserves space for current task even with large system context', () => {
  const history = [1, 2, 3, 4, 5].map(n => ({ role: 'system', content: `${n}`.repeat(12000) }));
  history.push(task);
  for (let n = 1; n <= 10; n++) history.push(...exchange(n));
  const snapshot = createRunHistorySnapshot(history);
  assert.ok(snapshot.messages.some(m => m.role === 'user' && m.content === task.content));
  assert.ok(JSON.stringify(snapshot.messages).length < 50 * 1024);
});

test('bounded checkpoint never keeps orphan results or drops results from a completed exchange', () => {
  for (const oversized of ['call', 'result']) {
    const history = [1, 2, 3].map(n => ({ role: 'system', content: `${n}`.repeat(12000) }));
    const [call, result] = exchange(1);
    call.content = 'x'.repeat(oversized === 'call' ? 12000 : 1000);
    call.tool_calls[0].function.arguments = JSON.stringify({ text: 'x'.repeat(oversized === 'call' ? 11000 : 8000) });
    result.content = 'r'.repeat(oversized === 'result' ? 12000 : 5);
    history.push(task, call, result);
    const snapshot = createRunHistorySnapshot(history);
    const calls = snapshot.messages.flatMap(m => m.tool_calls || []).map(c => c.id);
    const results = snapshot.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id);
    assert.deepEqual(calls, results, `${oversized} budget boundary must keep a complete exchange or omit both`);
  }
});

async function withModel(t, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    t.mock.timers.tick(1001);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '已完成第一部分。' : '剩余部分完成。' }, finish_reason: requests.length === 1 ? 'length' : 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { provider: 'checkpoint-test', id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', maxTokens: 8192 };
  const readJsonFile = file => file === 'auth' ? { [model.provider]: { key: 'fixture' } } : { [model.provider]: { models: [model] } };
  initDshKeys({ authPath: 'auth', modelsPath: 'models', readJsonFile });
  initUnifiedChat({ authPath: 'auth', modelsPath: 'models', readJsonFile, getModelList: () => [model], UNIFIED_TOOLS: [] });
  try { await run({ requests, chat: opts => unifiedChat(model, [task], opts) }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('truncation at budget boundary checkpoints partial text and recovery instruction before resume', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  await withModel(t, async ({ chat, requests }) => {
    const checkpoints = [];
    const paused = await chat({ executionBudgetMs: 1000, onCheckpoint: cp => checkpoints.push(cp) });
    assert.equal(paused.paused, true);
    const checkpoint = checkpoints.at(-1);
    assert.equal(checkpoint.phase, 'model_response');
    assert.ok(checkpoint.messages.some(m => m.content === '已完成第一部分。'));
    assert.ok(checkpoint.messages.some(m => /无需.*分块写/.test(m.content || '')));
    const resumed = await chat({ resumeSnapshot: checkpoint, resumeCheckpointKind: checkpoint.phase });
    assert.equal(resumed.error, undefined);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some(m => m.content === '已完成第一部分。'));
    assert.ok(requests[1].messages.some(m => /无需.*分块写/.test(m.content || '')));
  });
});

test('legacy checkpoint missing user recovers task from session context', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  await withModel(t, async ({ chat, requests }) => {
    const snapshot = { v: 1, turn: 10, messages: [{ role: 'system', content: '规则' }, ...exchange(10)] };
    await chat({ resumeSnapshot: snapshot, resumeCheckpointKind: 'tool_results' });
    assert.ok(requests[0].messages.some(m => m.role === 'user' && m.content === task.content));
  });
});
