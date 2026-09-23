import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { discoverCustomModels } from '../../engine/model-probe.mjs';
import { initModelProbe, probeModel } from '../../engine/model-health.mjs';
import { messagesEndpoint } from '../../engine/anthropic-messages.mjs';
import { HttpModelAdapter } from '../../engine/model-adapter.mjs';
import { verifyTextModel } from '../../engine/model-verification.mjs';

async function fixture(t, respond) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    respond(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}
test('catalog discovery never generates text or images and deduplicates IDs', async t => {
  const { base, calls } = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'alpha' }, { id: '' }] }));
  });
  const models = await discoverCustomModels(base, 'test-key');
  assert.deepEqual(calls.map(c => c.method), ['GET']);
  assert.deepEqual(models.map(m => m.id), ['alpha']);
  assert.equal(models[0].reasoning, false);
  assert.equal(models[0].discoverySource, 'catalog');
});
test('native discovery uses x-api-key and retains custom API path', async t => {
  const { base, calls } = await fixture(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'step-5' }] })));
  const models = await discoverCustomModels(`${base}/gateway/v2/messages/`, 'test-key', new Map(), { api: 'anthropic-messages' });
  assert.equal(calls[0].url, '/gateway/v2/models');
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(models[0].api, 'anthropic-messages');
});
test('401 and 429 remain actionable errors and do not trigger endpoint retries', async t => {
  for (const status of [401, 429]) {
    const { base, calls } = await fixture(t, (req, res) => { res.statusCode = status; res.end('upstream secret'); });
    await assert.rejects(discoverCustomModels(base, 'secret'), e => e.status === status && !e.message.includes('secret'));
    assert.equal(calls.length, 1);
  }
});
test('health rejects non-2xx and non-model responses', async () => {
  for (const response of [{ ok: false, status: 429 }, { ok: true, status: 200, json: async () => ({ hello: 'world' }) }]) {
    initModelProbe({ httpFetch: async () => response, authReader: () => ({ demo: { key: 'key' } }), modelsReader: () => ({}), getModelList: () => [] });
    assert.equal(await probeModel({ provider: 'demo', id: 'alpha', baseUrl: 'https://example.test' }), false);
  }
});
test('health uses native protocol and provider-level URL', async () => {
  let call;
  initModelProbe({ httpFetch: async (url, opts) => { call = { url, opts }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'OK' }] }) }; },
    authReader: () => ({ demo: { key: 'key' } }), modelsReader: () => ({ demo: { baseUrl: 'https://example.test/proxy/v2', api: 'anthropic-messages', models: [{ id: 'alpha' }] } }), getModelList: () => [] });
  assert.equal(await probeModel({ provider: 'demo', id: 'alpha' }), true);
  assert.equal(call.url, 'https://example.test/proxy/v2/messages');
  assert.equal(call.opts.headers['x-api-key'], 'key');
});
test('native invocation and discovery share explicit versioned endpoint semantics', () => {
  assert.equal(messagesEndpoint('https://example.test/gateway/v2'), 'https://example.test/gateway/v2/messages');
});
test('actual chat uses custom API path without adding a second version', async () => {
  let endpoint;
  const adapter = new HttpModelAdapter({ authReader: () => ({ demo: { key: 'key' } }), modelReader: () => ({}),
    httpFetch: async url => { endpoint = url; return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }; } });
  await adapter.chat({ provider: 'demo', id: 'alpha', baseUrl: 'https://example.test/api/v3' }, [{ role: 'user', content: 'hi' }]);
  assert.equal(endpoint, 'https://example.test/api/v3/chat/completions');
});

test('native catalog follows pagination and rejects empty or invalid catalogs', async t => {
  const f = await fixture(t, (req, res) => res.end(JSON.stringify(req.url.includes('after_id=')
    ? { data: [{ id: 'beta' }], has_more: false } : { data: [{ id: 'alpha' }], has_more: true, last_id: 'alpha' })));
  assert.deepEqual((await discoverCustomModels(f.base, 'key', new Map(), { api: 'anthropic-messages' })).map(m => m.id), ['alpha', 'beta']);
  assert.equal(f.calls[1].url, '/v1/models?after_id=alpha');
  for (const data of [{ data: [] }, { unexpected: true }]) {
    const bad = await fixture(t, (req, res) => res.end(JSON.stringify(data)));
    await assert.rejects(discoverCustomModels(bad.base, 'key'));
  }
});

test('token-budget exhaustion is inconclusive rather than malformed or unavailable', async () => {
  const result = await verifyTextModel({ id: 'reasoning', baseUrl: 'https://example.test' }, 'key', {
    httpFetch: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }) }) });
  assert.equal(result.status, 'inconclusive');
  assert.match(result.message, /预算/);
});

test('verification uses root-only endpoint fallback consistently with discovery', async t => {
  const f = await fixture(t, (req, res) => {
    res.statusCode = req.url.startsWith('/v1/') ? 404 : 200;
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  const result = await verifyTextModel({ id: 'alpha', baseUrl: f.base }, 'key');
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.map(c => c.url), ['/v1/chat/completions', '/chat/completions']);
});

test('verification respects a model-specific output token field', async () => {
  let body;
  await verifyTextModel({ id: 'alpha', baseUrl: 'https://example.test', compat: { maxTokensField: 'max_completion_tokens' } }, 'key', {
    httpFetch: async (_url, opts) => { body = JSON.parse(opts.body); return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }; } });
  assert.equal(body.max_completion_tokens, 64);
  assert.equal(body.max_tokens, undefined);
});
