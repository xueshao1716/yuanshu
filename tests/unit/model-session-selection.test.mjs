import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createModelSessionApi } from '../../engine/model-session.mjs';

function setup(model) {
  const entry = { sm: {}, modelKey: { provider: 'p', id: 'text' }, agent: { dispose() {} } };
  const built = [], saved = [];
  let response;
  const api = createModelSessionApi({
    json: (_, status, data) => { response = { status, data }; },
    getModelList: () => [model], getDefaultModel: () => ({ provider: 'p', id: 'text' }),
    getModelRuntime: () => ({ getModels: () => [model] }), activeSessions: new Map([['s', entry]]),
    createSessionAgent: async (_, m) => { built.push(m); return {}; },
    saveSessionModelKey: (...args) => saved.push(args), saveLastModel() {},
  });
  return { api, entry, built, saved, response: () => response };
}
test('switching to image or video keeps session choice without constructing a text agent', async () => {
  for (const id of ['flux/dev', 'wan2.5-t2v']) {
    const f = setup({ provider: 'p', id });
    await f.api.handleSwitchModel({}, {}, { provider: 'p', modelId: id, sessionId: 's' });
    assert.equal(f.response().status, 200);
    assert.equal(f.entry.modelKey.id, id);
    assert.equal(f.built.length, 0);
    assert.equal(f.entry.agent, null);
  }
});
test('audio-only and disabled models cannot become the chat model', async () => {
  for (const model of [{ id: 'tts-1' }, { id: 'whisper-1' }, { id: 'voice-realtime' }, { id: 'text', enabled: false }]) {
    const f = setup({ provider: 'p', ...model });
    await f.api.handleSwitchModel({}, {}, { provider: 'p', modelId: model.id, sessionId: 's' });
    assert.equal(f.response().status, 400);
    assert.equal(f.saved.length, 0);
    assert.equal(f.built.length, 0);
  }
});
test('Auto is an explicit session-scoped change', async () => {
  const f = setup({ provider: 'p', id: 'text' });
  await f.api.handleSwitchModel({}, {}, { provider: 'auto', modelId: 'auto', sessionId: 's' });
  assert.deepEqual(f.entry.modelKey, { provider: 'auto', id: 'auto' });
  assert.equal(f.response().status, 200);
});
test('chat picker sends Auto and concrete choices to the active session; audio has a dedicated hint', () => {
  const src = fs.readFileSync(new URL('../../frontend/src/components/ModelSelect.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('currentSessionId'));
  assert.ok(src.includes('sessionId: currentSessionId'));
  assert.ok(!src.includes("if (mk === 'auto/auto') return"));
  assert.ok(src.includes('isChatSelectable'));
  const card = fs.readFileSync(new URL('../../frontend/src/components/models/ModelCard.tsx', import.meta.url), 'utf8');
  assert.ok(card.includes('!chatSelectable'));
  assert.ok(card.includes('语音'));
});
test('usage loading failures show retry instead of indefinite skeleton or false zero totals', () => {
  const src = fs.readFileSync(new URL('../../frontend/src/pages/ModelHub.tsx', import.meta.url), 'utf8');
  assert.ok(src.includes('error: statsError'));
  assert.ok(src.includes('mutate: retryStats'));
  assert.ok(src.includes('!stats && !statsError'));
  assert.ok(src.includes('stats && <ProviderUsageTable'));
});
