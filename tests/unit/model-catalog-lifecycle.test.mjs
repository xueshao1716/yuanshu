import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDshKeys, refreshModelList } from '../../engine/dsh-keys.mjs';

test('refresh excludes disabled models and retains declared legacy capabilities', async () => {
  let list;
  const store = { fixture: { models: [
    { id: 'off', enabled: false },
    { id: 'custom-picture', capabilities: ['image'] },
  ] } };
  const runtime = { getModels: () => [{ provider: 'native', id: 'off', enabled: false }, { provider: 'native', id: 'voice', capabilities: ['realtime'] }] };
  initDshKeys({ readJsonFile: p => p === 'models' ? store : { fixture: { key: 'fixture' }, native: { key: 'fixture' } },
    modelsPath: 'models', authPath: 'auth', ModelRuntime: { create: async () => runtime },
    getModelRuntime: () => runtime, setModelRuntime: () => {}, setModelList: value => { list = value; }, getDefaultModel: () => null });
  await refreshModelList();
  assert.deepEqual(list.map(m => m.id), ['voice', 'custom-picture']);
  assert.equal(list[0].capabilities.realtime, true);
  assert.equal(list[0].capabilities.chat, false);
  assert.equal(list[1].capabilities.image, true);
  assert.equal(list[1].capabilities.chat, false);
});

test('startup and refresh share the same catalog normalizer', () => {
  for (const file of ['server.mjs', 'engine/dsh-keys.mjs']) {
    const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    assert.ok(source.includes('buildModelCatalog('), file);
  }
});
