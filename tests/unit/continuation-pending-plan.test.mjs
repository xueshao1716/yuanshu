import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRunHistorySnapshot, initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

const task = { role: 'user', content: '继续收集剩余页面' };
const callFor = (id, text = id) => ({ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ text }) } });
const planFor = calls => calls.map((call, ordinal) => ({ id: call.id, name: 'read', args: JSON.parse(call.function.arguments), ordinal: ordinal + 3, status: 'pending' }));

async function resumeFixture(t, history, plan, api = 'openai-completions') {
  const requests = [], executed = [], checkpoints = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(api === 'anthropic-messages'
      ? { content: [{ type: 'text', text: '完成' }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: '完成' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = { provider: 'pending-test', id: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api, maxTokens: 8192 };
  const readJsonFile = file => file === 'auth' ? { [model.provider]: { key: 'fixture' } } : { [model.provider]: { models: [model] } };
  initDshKeys({ authPath: 'auth', modelsPath: 'models', readJsonFile });
  initUnifiedChat({ authPath: 'auth', modelsPath: 'models', readJsonFile, getModelList: () => [model],
    UNIFIED_TOOLS: [{ name: 'read', parameters: { type: 'object' } }],
    executeUnifiedTool: async (name, args, context) => { executed.push({ name, args, turn: context.turn }); return { text: args.text }; },
  });
  const snapshot = createRunHistorySnapshot(history, { turn: 9 });
  const result = await unifiedChat(model, [task], { resumeSnapshot: snapshot, resumeCheckpointKind: 'tool_plan', resumeToolPlan: plan, onCheckpoint: cp => checkpoints.push(cp) });
  assert.equal(result.error, undefined);
  assert.equal(requests.length, 1);
  return { request: requests[0], executed, checkpoints, snapshot };
}

function assertPaired(messages, expected) {
  const calls = messages.flatMap(m => m.tool_calls || []);
  assert.deepEqual(calls, expected);
  const results = messages.filter(m => m.role === 'tool');
  assert.deepEqual(results.map(m => m.tool_call_id).sort(), expected.map(c => c.id).sort());
  const assistantIndex = messages.findIndex(m => m.tool_calls?.length);
  assert.ok(assistantIndex >= 0);
  assert.equal(messages.slice(assistantIndex + 1, assistantIndex + 1 + calls.length).every(m => m.role === 'tool'), true);
}

test('resume reconstructs pending calls dropped by checkpoint budget before appending results', async t => {
  const calls = [callFor('pending', 'x'.repeat(11000))];
  const history = [1, 2, 3].map(n => ({ role: 'system', content: `${n}`.repeat(12000) }));
  history.push(task, { role: 'assistant', content: 'a'.repeat(12000), tool_calls: calls });
  const { request, executed, checkpoints, snapshot } = await resumeFixture(t, history, planFor(calls));
  assert.equal(snapshot.messages.some(m => m.tool_calls?.length), false);
  assertPaired(request.messages, calls);
  assert.equal(executed[0].args.text.length, 11000);
  assert.equal(executed[0].turn, 9);
  assert.equal(checkpoints[0].toolPlan[0].ordinal, 3);
});

test('resume restores a partially retained batch as one call group including calls after sixteen', async t => {
  const calls = Array.from({ length: 18 }, (_, n) => callFor(`p${n}`));
  const { request, executed } = await resumeFixture(t, [task, { role: 'assistant', content: null, tool_calls: calls }], planFor(calls));
  assertPaired(request.messages, calls);
  assert.equal(request.messages.filter(m => m.tool_calls?.length).length, 1);
  assert.equal(executed.length, 18);
});

test('resume uses complete plan arguments instead of truncated snapshot arguments', async t => {
  const calls = [callFor('large', 'x'.repeat(15000))];
  const { request } = await resumeFixture(t, [task, { role: 'assistant', content: null, tool_calls: calls }], planFor(calls));
  assertPaired(request.messages, calls);
});

test('resume does not execute or duplicate an already recorded result from a stale pending plan', async t => {
  const calls = [callFor('done'), callFor('pending')];
  const { request, executed } = await resumeFixture(t, [task, { role: 'assistant', content: null, tool_calls: calls }, { role: 'tool', tool_call_id: 'done', content: 'saved' }], planFor(calls));
  assertPaired(request.messages, calls);
  assert.deepEqual(executed.map(e => e.args.text), ['pending']);
});

test('native resume preserves signed blocks while restoring all pending tool uses', async t => {
  const calls = Array.from({ length: 18 }, (_, n) => callFor(`native${n}`));
  const native = [{ type: 'thinking', thinking: 'reasoning', signature: 'signed-fixture' }, ...calls.map(c => ({ type: 'tool_use', id: c.id, name: 'read', input: JSON.parse(c.function.arguments) }))];
  const { request, executed } = await resumeFixture(t, [task, { role: 'assistant', content: '', tool_calls: calls, anthropic_content: native, anthropic_model: 'pending-test/fixture' }], planFor(calls), 'anthropic-messages');
  const assistant = request.messages.find(m => m.role === 'assistant');
  assert.deepEqual(assistant.content, native);
  assert.equal(request.messages.at(-1).content.filter(b => b.type === 'tool_result').length, 18);
  assert.equal(executed.length, 18);
});
