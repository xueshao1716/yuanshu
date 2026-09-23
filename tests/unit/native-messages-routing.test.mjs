import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';
import { HttpModelAdapter } from '../../engine/model-adapter.mjs';
import { initModelClient, directChat } from '../../engine/model-client.mjs';

test('all Yuanshu model entry points honor Messages, replay tools, and never reroute a 429', async () => {
  const requests = [], executed = []; let blocked = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url, headers: req.headers, body });
    if (blocked) { res.writeHead(429); return res.end('rate limited'); }
    const results = body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result') : []);
    const content = body.tools && !results.length
      ? [{ type: 'thinking', thinking: 'check', signature: 's1' }, { type: 'tool_use', id: 'c1', name: 'lookup', input: { query: 'fixture' } }]
      : [{ type: 'text', text: '完成：42' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', model: 'step-5-preview-actual', content, stop_reason: body.tools && !results.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 5, output_tokens: 10 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const model = { provider: 'test-native', id: 'step-5-preview', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${server.address().port}/step_plan/v1`, reasoning: true };
  const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }];
  const auth = { [model.provider]: { key: 'test-only' } }, store = { [model.provider]: { models: [model] } };
  const readJsonFile = file => file === 'test-auth' ? auth : store;
  initDshKeys({ authPath: 'test-auth', modelsPath: 'test-models', readJsonFile });
  initUnifiedChat({ authPath: 'test-auth', modelsPath: 'test-models', readJsonFile, getModelList: () => [model], UNIFIED_TOOLS: tools, executeUnifiedTool: async (name, args) => { executed.push({ name, args }); return { text: '42' }; } });
  initModelClient({ authPath: 'test-auth', modelsPath: 'test-models', readJsonFile, getModelList: () => [model], resolveAuth: () => ({}) });
  try {
    const result = await unifiedChat(model, [{ role: 'system', content: '元枢' }, { role: 'user', content: '查询后回答' }]);
    assert.equal(result.error, undefined); assert.equal(result.text, '完成：42');
    assert.equal(executed.length, 1, 'native tools must be enabled');
    assert.equal(result.usedModel.id, 'step-5-preview-actual');
    assert.equal(requests[1].body.messages[1].content[0].signature, 's1');
    assert.equal(requests[1].body.messages[2].content[0].tool_use_id, 'c1');
    const adapter = new HttpModelAdapter({ authReader: () => auth, modelReader: () => store });
    const adapted = await adapter.chat(model, [{ role: 'user', content: '查询' }], { tools });
    assert.equal(adapted.toolCalls[0].function.name, 'lookup');
    assert.equal(adapted.history.at(-1).anthropic_content[0].signature, 's1');
    assert.equal((await directChat(model, '继续', [{ role: 'user', content: '上文' }], { systemHint: '元枢' })).text, '完成：42');
    for (const request of requests) {
      assert.equal(request.url, '/step_plan/v1/messages');
      assert.equal(request.headers['x-api-key'], 'test-only');
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.body.reasoning_effort, undefined);
    }
    blocked = true; const count = requests.length;
    assert.match((await unifiedChat(model, [{ role: 'user', content: '限流' }])).error, /429/);
    assert.equal(requests.length, count + 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
