import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelOnboarding } from '../../engine/model-onboarding.mjs';
import { initDshKeys, handleModelsAdd, handleKeysApply, handleModelsManage } from '../../engine/dsh-keys.mjs';

async function setup(t, status = 200) {
  const calls = [], headers = [];
  const server = http.createServer((req, res) => { calls.push(req.url); headers.push(req.headers); res.statusCode = status; res.end(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'new' }] })); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const files = { auth: { demo: { key: 'old-key', baseUrl: base } }, models: { demo: { note: 'keep', models: [{ id: 'alpha', api: 'anthropic-messages', baseUrl: base, note: 'custom', reasoning: true, compat: { supportsStore: false }, verification: { ok: true } }, { id: 'manual-old', discoverySource: 'manual' }] } } };
  const writes = [];
  initDshKeys({ authPath: 'auth', modelsPath: 'models', readJsonFile: p => structuredClone(files[p]), writeJsonFile: (p, v) => { writes.push(p); files[p] = structuredClone(v); }, refreshModelList: async () => {}, ModelRuntime: { create: async () => { throw new Error('SDK missing'); } } });
  const res = { writeHead(code) { this.status = code; }, end(raw) { this.body = JSON.parse(raw); } };
  return { files, writes, calls, headers, base, res };
}
test('failed replacement preserves original key and model metadata', async t => {
  const f = await setup(t, 401), before = structuredClone(f.files);
  await handleModelsAdd(f.res, { provider: 'demo', key: 'new-key', baseUrl: f.base });
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.writes, []);
  assert.equal(f.res.status, 422); // upstream auth failure must not log the user out of Yuanshu
  assert.equal(f.res.body.upstreamStatus, 401);
});
test('refresh preserves per-model protocol and user metadata without pi SDK', async t => {
  const f = await setup(t);
  await handleModelsAdd(f.res, { provider: 'demo', baseUrl: f.base });
  assert.equal(f.res.status, 200);
  assert.equal(f.files.auth.demo.key, 'old-key');
  const alpha = f.files.models.demo.models.find(m => m.id === 'alpha');
  assert.equal(alpha.api, 'anthropic-messages');
  assert.equal(alpha.note, 'custom');
  assert.equal(alpha.reasoning, true);
  assert.equal(f.files.models.demo.note, 'keep');
  assert.ok(f.files.models.demo.models.find(m => m.id === 'manual-old'));
});
test('manual intake is explicitly unverified and performs no generation', async t => {
  const f = await setup(t, 404);
  await handleModelsAdd(f.res, { provider: 'fresh', key: 'new-key', baseUrl: f.base, api: 'anthropic-messages', modelIds: ['step-5', 'step-5'] });
  assert.equal(f.res.status, 200);
  assert.deepEqual(f.calls, []);
  assert.equal(f.files.models.fresh.models.length, 1);
  assert.equal(f.files.models.fresh.models[0].discoverySource, 'manual');
  assert.equal(f.files.models.fresh.models[0].api, 'anthropic-messages');
});
test('legacy model-level native protocol drives provider display and rediscovery auth', async t => {
  const f = await setup(t);
  await handleModelsManage(f.res);
  assert.equal(f.res.body.providers[0].api, 'anthropic-messages');
  await handleModelsAdd(f.res, { provider: 'demo' });
  assert.equal(f.res.status, 200);
  assert.equal(f.headers[0]['x-api-key'], 'old-key');
  assert.equal(f.headers[0].authorization, undefined);
  assert.equal(f.files.models.demo.models.find(m => m.id === 'new').api, 'anthropic-messages');
});
test('setup wizard uses same protocol-aware path without SDK', async t => {
  const f = await setup(t);
  await handleKeysApply(f.res, { provider: 'anthropic', apiKey: 'new-key', baseUrl: f.base });
  assert.equal(f.res.status, 200);
  assert.equal(f.files.models.anthropic.models[0].api, 'anthropic-messages');
});

test('rediscovery prefers the configured model endpoint over stale auth metadata', async t => {
  const f = await setup(t);
  f.files.auth.demo.baseUrl = 'http://127.0.0.1:1/old';
  await handleModelsAdd(f.res, { provider: 'demo' });
  assert.equal(f.res.status, 200);
  assert.equal(f.files.models.demo.models[0].baseUrl, f.base);
});

test('false-returning persistence failure rolls back instead of reporting saved', async () => {
  const files = { auth: { demo: { key: 'old-key' } }, models: { demo: { models: [] } } };
  const before = structuredClone(files);
  const handler = createModelOnboarding({ read: p => structuredClone(files[p]), write: (p, v) => {
    if (p === 'auth') return false;
    files[p] = structuredClone(v); return true;
  }, authPath: 'auth', modelsPath: 'models', presets: {}, refresh: async () => {}, json: (res, status, body) => Object.assign(res, { status, body }) });
  const res = {};
  await handler.add(res, { provider: 'demo', key: 'new-key', baseUrl: 'https://example.test/v1', modelIds: ['alpha'] });
  assert.notEqual(res.status, 200);
  assert.equal(res.body.saved, false);
  assert.deepEqual(files, before);
});
