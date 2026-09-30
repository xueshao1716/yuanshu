import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunEffects } from '../../engine/run-effects.mjs';

const moduleUrl = new URL('../../engine/chat-media-selection.mjs', import.meta.url);
const load = async () => {
  assert.ok(fs.existsSync(moduleUrl), 'selected chat models need a shared validated dispatch path');
  return import(moduleUrl);
};
const models = [
  { provider: 'p', id: 'flux/dev' }, { provider: 'p', id: 'wan2.5-t2v' },
  { provider: 'p', id: 'text' }, { provider: 'p', id: 'voice-realtime' },
  { provider: 'p', id: 'off', enabled: false },
  { provider: 'p', id: 'multi-image', capabilities: { chat: true, image: true } },
];
test('chat dispatch respects selected catalog capabilities and slash-containing IDs', async () => {
  const { resolveChatSelection } = await load();
  for (const [id, kind] of [['flux/dev', 'image'], ['wan2.5-t2v', 'video'], ['text', 'chat'], ['multi-image', 'chat']]) {
    const selected = resolveChatSelection({ models, requested: `p/${id}`, modelKey: { provider: 'p', id: 'text' } });
    assert.equal(selected.model.id, id);
    assert.equal(selected.kind, kind);
  }
  assert.equal(resolveChatSelection({ models, requested: 'auto/auto', modelKey: models[0] }).model.id, 'flux/dev');
  assert.equal(resolveChatSelection({ models, requested: 'auto/auto' }).kind, 'auto');
});
test('missing, disabled and audio-only selections fail without silently choosing text', async () => {
  const { resolveChatSelection } = await load();
  for (const id of ['missing', 'off', 'voice-realtime']) {
    assert.throws(() => resolveChatSelection({ models, requested: `p/${id}` }), /未找到|不可用|专用/);
    assert.throws(() => resolveChatSelection({ models, modelKey: { provider: 'p', id } }), /未找到|不可用|专用/);
  }
});
function fixture(overrides = {}) {
  const req = new EventEmitter(), res = new EventEmitter();
  const chunks = [], messages = [];
  res.write = chunk => { chunks.push(chunk); return true; };
  res.end = () => { res.writableEnded = true; };
  const entry = { gen: 1, busy: true, sm: { appendMessage: m => messages.push(m) } };
  let requests = 0, invalidations = 0;
  const options = { req, res, entry, generation: 1, model: models[0], kind: 'image', message: '画一片山',
    runContext: {}, entries: [],
    generateImage: async (...args) => { requests++; assert.equal(args[1], 'flux/dev'); return 'data:image/png;base64,eA=='; },
    generateVideo: async () => { requests++; return { video: 'https://example.invalid/video.mp4' }; },
    saveArtifact: async () => ({ url: '/api/ws/file?path=image.png', local: true }),
    invalidate: () => invalidations++, ...overrides };
  return { options, req, res, entry, messages, chunks, requests: () => requests, invalidations: () => invalidations,
    events: () => chunks.join('').split('\n\n').filter(x => x.startsWith('event:')).map(x => ({ type: x.split('\n')[0].slice(7), data: JSON.parse(x.split('\n')[1].slice(6)) })) };
}
test('selected media is emitted as SSE and persisted in SDK-safe history with provenance', async () => {
  const { runSelectedMedia } = await load();
  for (const kind of ['image', 'video']) {
    const f = fixture({ kind });
    await runSelectedMedia(f.options);
    assert.equal(f.requests(), 1);
    const events = f.events();
    assert.equal(events.find(e => e.type === 'media').data.type, kind);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(events.at(-1).data.model.id, 'flux/dev');
    assert.equal(f.messages[0].role, 'user');
    assert.equal(f.messages[1].provider, 'p');
    assert.equal(f.messages[1].model, 'flux/dev');
    assert.ok(f.messages[1].content.every(b => b.type === 'text'));
    assert.match(f.messages[1].content[0].text, /api\/ws\/file/);
    assert.equal(f.entry.busy, false);
    assert.equal(f.req.listenerCount('close'), 0);
    assert.equal(f.invalidations(), 1);
    assert.ok(f.res.writableEnded);
  }
});
test('upstream rejection is visible and releases busy state', async () => {
  const { runSelectedMedia } = await load();
  const f = fixture({ generateImage: async () => { throw new Error('429 额度不足'); } });
  await runSelectedMedia(f.options);
  assert.match(f.events().find(e => e.type === 'error').data.message, /429/);
  assert.equal(f.entry.busy, false);
  assert.ok(f.res.writableEnded);
});
test('cancel aborts upstream promptly and cannot deliver into a newer turn', async () => {
  const { runSelectedMedia } = await load();
  let signal, release;
  const f = fixture({ generateImage: async (...args) => { signal = args[5].signal; return new Promise(r => { release = r; }); } });
  const pending = runSelectedMedia(f.options);
  await new Promise(r => setImmediate(r));
  f.entry.gen = 2;
  f.req.emit('close');
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(f.entry.busy, true);
  assert.equal(f.invalidations(), 0);
  release('https://example.invalid/late.png');
  await new Promise(r => setImmediate(r));
  assert.equal(f.messages.filter(m => m.role === 'assistant').length, 0);
  assert.equal(f.events().filter(e => e.type === 'media').length, 0);
});
test('deadline ends a stuck generation and aborts its request', async () => {
  const { runSelectedMedia } = await load();
  const f = fixture({ runContext: { executionDeadlineAt: Date.now() + 30 }, generateImage: () => new Promise(() => {}) });
  await runSelectedMedia(f.options);
  assert.match(f.events().find(e => e.type === 'error').data.message, /超时/);
  assert.equal(f.entry.busy, false);
});
test('a request already cancelled before dispatch performs no purchase', async () => {
  const { runSelectedMedia } = await load();
  const f = fixture({ runContext: { signal: AbortSignal.abort() } });
  await runSelectedMedia(f.options);
  await new Promise(r => setImmediate(r));
  assert.equal(f.requests(), 0);
  assert.equal(f.entry.busy, false);
});
test('resuming never repurchases an uncertain or legacy media operation', async t => {
  const { runSelectedMedia } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-media-effects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const effects = createRunEffects({ rootDir: root });
  const first = fixture({ runContext: { runId: 'r1', effects }, generateImage: async () => { throw new Error('connection reset'); } });
  await runSelectedMedia(first.options);
  for (const runContext of [{ runId: 'r1', effects, resume: true }, { resume: true }]) {
    const f = fixture({ runContext });
    await runSelectedMedia(f.options);
    assert.equal(f.requests(), 0);
    assert.match(f.events().find(e => e.type === 'error').data.message, /重复|恢复/);
    assert.equal(f.entry.busy, false);
  }
});
test('completed local media is reused without charging again or duplicating history', async t => {
  const { runSelectedMedia } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-media-effects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const effects = createRunEffects({ rootDir: root });
  const first = fixture({ runContext: { runId: 'r2', effects } });
  await runSelectedMedia(first.options);
  const f = fixture({ runContext: { runId: 'r2', effects, resume: true }, entries: first.messages.map(message => ({ type: 'message', message })) });
  await runSelectedMedia(f.options);
  assert.equal(f.requests(), 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.events().at(-1).type, 'done');
});
test('server integrates selected-media dispatch before either text engine', () => {
  const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('await runSelectedMedia('), 'media needs the same SSE contract as runs');
  assert.ok(source.indexOf('resolveChatSelection({') < source.indexOf('await runSelectedMedia('));
  assert.ok(source.indexOf('await runSelectedMedia(') < source.indexOf('await handleDshChat(res, entry'));
  assert.ok(!source.includes('generateImage(defaultModel.provider, defaultModel.id, message)'));
});
