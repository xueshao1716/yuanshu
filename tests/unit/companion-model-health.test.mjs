import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { directChat, initModelClient } from '../../engine/model-client.mjs';
import { isModelBlocked, resetModelHealth } from '../../engine/model-router.mjs';
for (const api of ['openai-completions', 'anthropic-messages', 'openai-responses']) test(`companion ${api} failure does not cool normal chat`, async t => {
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { resetModelHealth(); return new Promise(r => server.close(r)); });
  const model = { provider: 'companion-test', id: api, api, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  initModelClient({ authPath: 'auth', modelsPath: 'models', readJsonFile: p => p === 'auth' ? { 'companion-test': { key: 'test' } } : {}, getModelList: () => [model] });
  resetModelHealth();
  await directChat(model, 'hi', [], { trackModelHealth: false });
  assert.equal(isModelBlocked(model), false);
  await directChat(model, 'hi');
  assert.equal(isModelBlocked(model), true);
});
