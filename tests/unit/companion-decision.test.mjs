import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionDecision, compactMessages } from '../../engine/companion-decision.mjs';
import { createCompanionStore } from '../../engine/companion-store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const result = { action: 'resting', expression: 'calm', utterance: '先歇一会。', reason: '当前空闲', evidenceIds: [], durationMs: 10000, shouldInterrupt: false };
const request = { sessionId: 'mine', contextEpoch: 'view-1', interactionId: 'click-1', trigger: 'tap', visible: true };
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-decision-'));
  let now = 10000, calls = 0;
  const facts = { sessionId: 'mine', serverEpoch: 'server', revision: 'r1', known: true, currentBusy: false, otherBusy: 0, reading: false, evidenceIds: [] };
  const store = createCompanionStore({ root, now: () => now });
  const service = createCompanionDecision({ store, now: () => now, facts: { read: () => ({ ...facts }) },
    emotion: { read: () => ({ state: null }) }, readSession: id => { assert.equal(id, 'mine'); return { model: { provider: 'test', id: 'registered' }, messages: [{ role: 'user', content: '当前会话' }] }; },
    callModel: async (_model, prompt, history, options) => { calls++; assert.ok(prompt.includes('当前会话')); assert.ok(!options.tools); assert.equal(options.trackModelHealth, false); assert.equal(options.allowPartial, true); return { text: JSON.stringify(result), usedModel: { provider: 'test', id: 'actual' } }; }, ...overrides });
  return { service, store, root, facts, calls: () => calls, advance: ms => { now += ms; } };
}
test('decision uses bounded current-session context, actual model, and idempotency', async () => {
  const f = fixture();
  const a = await f.service.decide(request);
  assert.equal(a.status, 'ok'); assert.equal(a.decision.actualModel.id, 'actual');
  assert.equal(a.decision.action, 'resting');
  assert.deepEqual(await f.service.decide(request), a); assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(f.store.history('mine')).includes('当前会话'));
  const text = compactMessages(Array.from({ length: 10 }, () => ({ role: 'user', content: 'x'.repeat(2000) })));
  assert.ok(text.length <= 6); assert.ok(text.reduce((n, m) => n + m.content.length, 0) <= 6000);
});
test('busy overrides rest; changed evidence discards delayed model response', async () => {
  const f = fixture(); f.facts.currentBusy = true;
  assert.equal((await f.service.decide(request)).decision.action, 'working');
  let done;
  const g = fixture({ callModel: () => new Promise(resolve => { done = resolve; }) });
  const pending = g.service.decide(request);
  await new Promise(resolve => setImmediate(resolve));
  g.facts.revision = 'r2'; done({ text: JSON.stringify(result), usedModel: { id: 'actual', provider: 'test' } });
  assert.equal((await pending).status, 'stale');
});
test('hidden automatic requests, quotas, invalid model output and timeouts fail honestly', async () => {
  const f = fixture();
  assert.equal((await f.service.decide({ ...request, trigger: 'auto', visible: false })).status, 'hidden');
  await f.service.decide(request);
  assert.equal((await f.service.decide({ ...request, interactionId: 'second' })).status, 'rate_limited');
  const invalid = fixture({ callModel: async () => ({ text: JSON.stringify({ ...result, action: 'execute_shell' }) }) });
  assert.equal((await invalid.service.decide(request)).status, 'invalid');
  const hanging = fixture({ timeoutMs: 10, callModel: () => new Promise(() => {}) });
  assert.equal((await hanging.service.decide(request)).status, 'unavailable');
});
test('preferences persist and suppress automatic bubbles; history expires and is capped', async () => {
  const f = fixture(); f.store.preferences({ dnd: true });
  assert.equal(createCompanionStore({ root: f.root }).preferences().dnd, true);
  assert.equal((await f.service.decide({ ...request, trigger: 'auto' })).status, 'dnd');
  for (let i = 0; i < 1005; i++) f.store.record({ sessionId: 'mine', interactionId: String(i), status: 'ok' });
  assert.equal(f.store.history('mine').length, 1000);
  assert.equal(f.store.history('other').length, 0);
  f.advance(8 * 86400000); assert.equal(f.store.history('mine').length, 0);
});

test('conversation changes invalidate pending decisions even when task facts did not change', async () => {
  let revision = 'message-1', done;
  const f = fixture({ readSession: () => ({ model: { provider: 'test', id: 'registered' }, messages: [], revision }),
    callModel: () => new Promise(resolve => { done = resolve; }) });
  const pending = f.service.decide(request);
  await new Promise(resolve => setImmediate(resolve));
  revision = 'message-2';
  done({ text: JSON.stringify(result), usedModel: { provider: 'test', id: 'actual' } });
  assert.equal((await pending).status, 'stale');
});
test('deadline covers stalled session reads and releases the inflight slot', async () => {
  const f = fixture({ timeoutMs: 10, readSession: () => new Promise(() => {}) });
  const result = await Promise.race([f.service.decide(request), new Promise(resolve => setTimeout(() => resolve({ status: 'hung' }), 100))]);
  assert.equal(result.status, 'unavailable');
  f.advance(61000);
  const next = await Promise.race([f.service.decide({ ...request, interactionId: 'next' }), new Promise(resolve => setTimeout(() => resolve({ status: 'hung' }), 100))]);
  assert.equal(next.status, 'unavailable');
});
test('missing facts are recorded and apply failure backoff for automatic retries', async () => {
  const f = fixture(); f.facts.known = false;
  assert.equal((await f.service.decide({ ...request, trigger: 'auto' })).status, 'facts_unavailable');
  assert.equal(f.store.history('mine').length, 1);
  f.advance(31000);
  assert.equal((await f.service.decide({ ...request, trigger: 'auto', interactionId: 'next' })).status, 'rate_limited');
});

test('duplicate inflight interactions share one model call without one tab cancelling another', async () => {
  let finish, calls = 0;
  const f = fixture({ callModel: (_m, _p, _h, options) => {
    calls++; return new Promise(resolve => { finish = () => {
      assert.equal(options.signal.aborted, false);
      resolve({ text: JSON.stringify(result), usedModel: { id: 'actual', provider: 'test' } });
    }; });
  } });
  const first = new AbortController(), second = new AbortController();
  const a = f.service.decide(request, first.signal);
  const b = f.service.decide(request, second.signal);
  await new Promise(resolve => setImmediate(resolve));
  first.abort();
  assert.equal((await a).status, 'cancelled');
  finish();
  assert.equal((await b).status, 'ok');
  assert.equal(calls, 1);
  assert.equal(f.store.history('mine').length, 1);
});

test('all disconnected subscribers cancel the shared companion request', async () => {
  let modelSignal;
  const f = fixture({ callModel: (_m, _p, _h, options) => { modelSignal = options.signal; return new Promise(() => {}); } });
  const controller = new AbortController();
  const pending = f.service.decide(request, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal(modelSignal.aborted, true);
});
