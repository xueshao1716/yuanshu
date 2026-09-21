import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HttpModelAdapter } from '../../engine/model-adapter.mjs';
import { initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

const reasoning = '先检查工具结果，再回答。\n保留原始思考字段。';
const toolMessage = {
  content: null, reasoning_content: reasoning,
  tool_calls: [{ id: 'inspect-1', type: 'function', function: { name: 'inspect', arguments: '{}' } }],
};

test('HTTP 适配器在工具后续请求中保留 reasoning_content', async () => {
  const requests = [];
  const adapter = new HttpModelAdapter({
    authReader: () => ({ mock: { key: 'test' } }),
    httpFetch: async (_url, opts) => {
      requests.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: requests.length === 1 ? toolMessage : { content: '完成' } }] }) };
    },
  });
  const model = { provider: 'mock', id: 'thinking', baseUrl: 'https://mock.invalid/v1', reasoning: true };
  const first = await adapter.chat(model, [{ role: 'user', content: '检查' }]);
  await adapter.chat(model, [...first.history, { role: 'tool', tool_call_id: 'inspect-1', content: 'ok' }]);
  assert.equal(requests[1].messages.find(m => m.tool_calls)?.reasoning_content, reasoning);
});

test('统一流式工具循环下一轮请求保留 reasoning_content', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const message = requests.length === 1 ? toolMessage : { content: '检查完成。' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ message }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const model = { provider: 'mock', id: 'thinking', baseUrl: `http://127.0.0.1:${server.address().port}`, reasoning: true, api: 'openai-completions' };
    const readJsonFile = p => p === 'mock-auth' ? { mock: { key: 'test' } } : { mock: { models: [model] } };
    initDshKeys({ authPath: 'mock-auth', modelsPath: 'mock-models', readJsonFile });
    initUnifiedChat({ authPath: 'mock-auth', modelsPath: 'mock-models', readJsonFile,
      getModelList: () => [model], getDefaultModel: () => model,
      UNIFIED_TOOLS: [{ type: 'function', function: { name: 'inspect', parameters: { type: 'object' } } }],
      executeUnifiedTool: async () => ({ text: 'ok', isError: false }),
    });
    const result = await unifiedChat(model, [{ role: 'user', content: '检查' }], { maxTurns: 3 });
    assert.equal(result.error, undefined);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].messages.find(m => m.tool_calls)?.reasoning_content, reasoning);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
