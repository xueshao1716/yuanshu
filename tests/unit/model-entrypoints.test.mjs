import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUiDesignService } from '../../engine/ui-design-service.mjs';
import { createWebsiteService } from '../../engine/website-service.mjs';
import { verifyTextModel } from '../../engine/model-verification.mjs';

const read = file => fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
const specialized = ['tts-1', 'whisper-1', 'stepaudio-2.5-realtime', 'flux-1'];

test('text-only workshop services reject audio and disabled models before starting work', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-model-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const model of [...specialized.map(id => ({ provider: 'test', id })), { provider: 'test', id: 'chat', enabled: false }]) {
    const ctx = { root, getModelList: () => [model], getDefaultModel: () => model, directChat: () => assert.fail('must not call upstream') };
    const ui = createUiDesignService(ctx), p = ui.store.create({ title: model.id, brief: '模型分类测试' });
    assert.throws(() => ui.start(p.id, { model: `test/${model.id}` }), /文本模型/);
    assert.equal(ui.get(p.id).run, null);
    const web = createWebsiteService(ctx);
    assert.throws(() => web.create({ title: model.id, brief: '模型分类测试', generate: true, model: `test/${model.id}` }), /文本模型/);
  }
});

test('text verification never submits requests to inferred specialized models', async () => {
  let calls = 0;
  for (const id of specialized) {
    const result = await verifyTextModel({ id, baseUrl: 'https://fixture.invalid/v1' }, 'fixture', {
      httpFetch: async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }; },
    });
    assert.equal(result.ok, false, id);
    assert.match(result.message, /媒体模型/);
  }
  assert.equal(calls, 0);
});

test('model hub and workshop use shared capabilities and distinguish local usage from quota', () => {
  for (const file of ['frontend/src/components/UiDesignDetail.tsx', 'frontend/src/components/models/ModelCard.tsx']) {
    assert.ok(read(file).includes('isTextModel'), file);
  }
  const hub = read('frontend/src/pages/ModelHub.tsx');
  assert.ok(hub.includes('effectiveCapabilities'));
  assert.ok(hub.includes('服务商余额'));
  assert.ok(hub.includes('本机记录'));
  const filters = read('frontend/src/components/models/ModelFilterBar.tsx');
  for (const kind of ['image', 'video', 'tts', 'asr', 'realtime']) assert.ok(filters.includes(`'${kind}'`), kind);
});
