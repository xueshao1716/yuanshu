import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import * as api from '../../engine/chat-voice-api.mjs';
import { createVoiceTaskAuthorizer } from '../../engine/voice-task-auth.mjs';

const modules = () => import('../../engine/voice-model-registry.mjs').catch(() => ({}));
const modelKey = 'stepfun-plan/stepaudio-2.5-realtime';

test('server voice registry wiring initializes and rechecks raw model disable flags', async () => {
  const { createVoiceModelRegistry } = await modules();
  const line = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8').split('\n')
    .find(line => line.startsWith('const voiceModels = createVoiceModelRegistry('));
  assert.ok(line);
  let store = { 'stepfun-plan': { models: [{ id: 'stepaudio-2.5-realtime', enabled: false }] } };
  const registry = vm.runInNewContext(`${line}\nvoiceModels`, { createVoiceModelRegistry,
    AUTH_PATH: 'auth', MODELS_PATH: 'models', modelList: [],
    readJsonFile: file => file === 'auth' ? { 'stepfun-plan': { key: 'fixture-secret' } } : store });
  assert.equal(registry.list().length, 0);
  assert.throws(() => registry.resolve(modelKey), /voice_model_unavailable/);
  store = {};
  assert.equal(registry.list().length, 1);
  store = { 'stepfun-plan': { models: [{ id: 'stepaudio-2.5-realtime', capabilities: { realtime: false } }] } };
  assert.equal(registry.list().length, 0);
});

test('registry only lists configured adapters and rechecks revoked credentials', async () => {
  const { createVoiceModelRegistry } = await modules();
  assert.equal(typeof createVoiceModelRegistry, 'function');
  let auth = {}, models = [];
  const registry = createVoiceModelRegistry({ readAuth: () => auth, getModels: () => models });
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.resolve(), /voice_model_unavailable/);
  auth = { 'stepfun-plan': { key: 'fixture-secret' }, other: { key: 'other-secret' } };
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].modelKey, modelKey);
  assert.doesNotMatch(JSON.stringify(list), /secret|wss:|baseUrl|apiKey/);
  assert.equal(registry.resolve(modelKey).key, 'fixture-secret');
  assert.throws(() => registry.resolve('https://evil.test'), /voice_model_unsupported/);
  models = [{ provider: 'stepfun-plan', id: 'stepaudio-2.5-realtime', enabled: false }];
  assert.deepEqual(registry.list(), []);
  assert.throws(() => registry.resolve(modelKey), /voice_model_unavailable/);
  models = []; auth = {};
  assert.throws(() => registry.resolve(modelKey), /voice_model_unavailable/);
});

test('voice model catalog requires auth, checks origin, is no-store and omits secrets', async t => {
  assert.equal(typeof api.createVoiceModelsHandler, 'function');
  const { createVoiceModelRegistry } = await modules();
  const registry = createVoiceModelRegistry({ readAuth: () => ({ 'stepfun-plan': { key: 'private-key' } }) });
  const handler = api.createVoiceModelsHandler({ registry,
    authorize: createVoiceTaskAuthorizer({ getToken: () => 'fixture', origins: ['https://chat.test'] }) });
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/voice/models`;
  assert.equal((await fetch(url + '?token=fixture')).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: 'Bearer fixture', Origin: 'https://evil.test' } })).status, 401);
  const res = await fetch(url, { headers: { Authorization: 'Bearer fixture' } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
  const data = await res.json();
  assert.equal(data.models[0].modelKey, modelKey);
  assert.doesNotMatch(JSON.stringify(data), /private-key|wss:/);
});
