import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpModelAdapter } from '../../engine/model-adapter.mjs';

async function requestFor(definition, opts = {}) {
  const requests = [];
  const adapter = new HttpModelAdapter({
    authReader: () => ({ mock: { key: 'test' } }),
    modelReader: () => ({ mock: { models: [{ id: 'model', baseUrl: 'https://mock.invalid/v1', ...definition }] } }),
    httpFetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '完整正文' }, finish_reason: 'stop' }] }) };
    },
  });
  await adapter.chat({ provider: 'mock', id: 'model' }, [{ role: 'user', content: '写正文' }], opts);
  return requests[0];
}

test('unsupported medium effort uses supported low, never silently upgrades GLM to high', async () => {
  const body = await requestFor({ reasoning: true,
    compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
  }, { reasoningEffort: 'medium', maxTokens: 12000, outputCeiling: 12000 });
  assert.equal(body.reasoning_effort, 'low');
  assert.equal(body.max_tokens, 12000);
});

test('supported effort and ordinary adapter default stay unchanged', async () => {
  assert.equal((await requestFor({ reasoning: true }, { reasoningEffort: 'medium' })).reasoning_effort, 'medium');
  assert.equal((await requestFor({ reasoning: true })).reasoning_effort, 'high');
  assert.equal((await requestFor({ reasoning: false }, { reasoningEffort: 'medium' })).reasoning_effort, undefined);
});

test('explicit unsupported capability wins over a level map', async () => {
  const body = await requestFor({ reasoning: true, compat: { supportsReasoningEffort: false },
    thinkingLevelMap: { low: 'low', high: 'high' } }, { reasoningEffort: 'low' });
  assert.equal(body.reasoning_effort, undefined);
});

test('a map without any supported lower effort never upgrades to high', async () => {
  const body = await requestFor({ reasoning: true,
    thinkingLevelMap: { low: null, medium: null, high: 'high' } }, { reasoningEffort: 'low' });
  assert.equal(body.reasoning_effort, undefined);
});

test('quota refusal remains visible and never triggers another paid request', async () => {
  let calls = 0;
  const adapter = new HttpModelAdapter({
    authReader: () => ({ mock: { key: 'test' } }),
    httpFetch: async () => {
      calls++;
      return { ok: false, status: 403, text: async () => JSON.stringify({ error: { message: '用户额度不足' } }) };
    },
  });
  const result = await adapter.chat({ provider: 'mock', id: 'model', baseUrl: 'https://mock.invalid/v1', reasoning: true },
    [{ role: 'user', content: '正文' }], { reasoningEffort: 'medium' });
  assert.equal(calls, 1);
  assert.match(result.error, /403.*用户额度不足/);
  assert.equal(result.text, undefined);
});
