import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initModelClient, maybeCompactHistory } from '../../engine/model-client.mjs';
import { initUnifiedChat, unifiedChat, createRunHistorySnapshot } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

const summary = '1. 用户要求核查开源项目\n2. 已查实现\n3. repo/src\n4. 无错误\n5. 已读文件\n6. 继续核查';
const opts = { minMessages: 10, minChars: 20000 };
function history() {
  return [{ role: 'system', content: '身份与权限不可改变' },
    { role: 'developer', content: '禁止改写原始记录' },
    { role: 'user', content: '核查这个开源项目值得学习的部分' },
    ...Array.from({ length: 10 }, (_, i) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: `t${i}`, content: '证据'.repeat(1600) },
    ]).flat()];
}
function paired(messages) {
  const calls = new Set();
  for (const m of messages) {
    for (const c of m.tool_calls || []) calls.add(c.id);
    if (m.role === 'tool') assert.ok(calls.delete(m.tool_call_id), `orphan ${m.tool_call_id}`);
  }
  assert.equal(calls.size, 0, 'no dangling tool calls');
}

test('真实统一通道收到规范压缩消息，而不是数千个字符对象', async t => {
  let received;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    received = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ message: { content: summary } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const model = { provider: 'compact-test', id: 'mock', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const readJsonFile = p => p === 'auth' ? { 'compact-test': { key: 'test-only' } } : { 'compact-test': { models: [model] } };
  const config = { authPath: 'auth', modelsPath: 'models', readJsonFile, getModelList: () => [model], getDefaultModel: () => model };
  initDshKeys(config); initUnifiedChat(config); initModelClient({ unifiedChat });
  await maybeCompactHistory(history(), model, '', opts);
  assert.ok(received.messages.every(m => typeof m.role === 'string'), 'all request messages have roles');
  assert.ok(received.messages.some(m => m.role === 'user' && m.content.includes('核查这个开源项目')));
  const original = history().slice(0, 3);
  const resumeSnapshot = createRunHistorySnapshot([
    { role: 'system', content: '【早前对话摘要】你没有发来内容' },
    { role: 'assistant', content: '旧任务已读了文件' },
  ]);
  await unifiedChat(model, original, { resumeSnapshot, tools: false });
  assert.ok(received.messages.some(m => m.role === 'system' && m.content === original[0].content), 'resume restores authoritative system context');
  assert.ok(received.messages.some(m => m.role === 'developer' && m.content === original[1].content));
  assert.ok(received.messages.some(m => m.role === 'user' && m.content === original[2].content));
  assert.ok(!received.messages.some(m => m.role === 'system' && m.content.startsWith('【早前对话摘要】')), 'legacy summary cannot override current authority');
});

test('压缩长工具轮仍保留原系统约束和当前问题，且不修改原记录', async () => {
  initModelClient({ unifiedChat: async () => ({ text: summary }) });
  const input = history(), original = JSON.stringify(input);
  const out = await maybeCompactHistory(input, {}, '', opts);
  assert.ok(out.includes(input[0])); assert.ok(out.includes(input[1])); assert.ok(out.includes(input[2]));
  assert.ok(out.length < input.length); paired(out);
  assert.equal(JSON.stringify(input), original);
  assert.ok(out.some(m => m._section === 'compaction' && m.role === 'assistant'), 'summary is data, not new system authority');
});

test('压缩边界不会截断并行工具调用及其结果', async () => {
  initModelClient({ unifiedChat: async () => ({ text: summary }) });
  const input = history();
  input.splice(-10, 2,
    { role: 'assistant', content: null, tool_calls: ['p1', 'p2', 'p3'].map(id => ({ id, type: 'function', function: { name: 'read', arguments: '{}' } })) },
    ...['p1', 'p2', 'p3'].map(id => ({ role: 'tool', tool_call_id: id, content: '并行结果' })),
  );
  input.push({ role: 'assistant', content: '最后说明' });
  const out = await maybeCompactHistory(input, {}, '', opts);
  paired(out);
  const again = await maybeCompactHistory(out, {}, '', { minMessages: 1, minChars: 1 });
  paired(again); assert.ok(again.includes(input[2]));
  assert.equal(again.filter(m => m._section === 'compaction').length, 1);
});

for (const response of [{ text: '你没有发来任何内容' }, { text: ' ' }, { text: summary, error: 'failed' }, {}]) {
  test(`无效摘要保留原上下文：${JSON.stringify(response).slice(0, 35)}`, async () => {
    initModelClient({ unifiedChat: async () => response });
    const input = history(); assert.ok(await maybeCompactHistory(input, {}, '', opts) === input);
  });
}
test('短记录不发起压缩；调用失败不丢上下文', async () => {
  let calls = 0; initModelClient({ unifiedChat: async () => { calls++; throw new Error('offline'); } });
  const short = [{ role: 'user', content: 'hi' }];
  assert.equal(await maybeCompactHistory(short, {}), short); assert.equal(calls, 0);
  const input = history(); assert.equal(await maybeCompactHistory(input, {}, '', opts), input);
});
test('统一通道拒绝字符串和无角色消息，不再静默展开', async () => {
  await assert.rejects(unifiedChat({}, 'not an array'), /messages/i);
  await assert.rejects(unifiedChat({}, [{ '0': '字' }]), /messages/i);
});
