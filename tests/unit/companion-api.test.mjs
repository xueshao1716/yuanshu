import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCompanionRoutes } from '../../engine/companion-api.mjs';
test('unknown sessions cannot read facts/history or invoke the model', async () => {
  let called = false;
  const routes = createCompanionRoutes({ exists: id => id === 'valid', facts: { read: () => { called = true; } },
    store: {}, decisions: {}, json: (_res, code) => code, readBody: async () => ({ sessionId: '../secret' }) });
  const get = routes.find(r => r[1] === '/api/companion/facts');
  assert.equal(await get[2]({}, {}, new URL('http://local/api/companion/facts?sessionId=../secret')), 404);
  const post = routes.find(r => r[1] === '/api/companion/decision');
  assert.equal(await post[2]({}, new EventEmitter()), 404);
  assert.equal(called, false);
});
test('disconnect cancels model decision without cancelling main run', async () => {
  let seen;
  const req = new EventEmitter(), res = new EventEmitter();
  const routes = createCompanionRoutes({ exists: () => true, facts: {}, store: {},
    decisions: { decide: async (_body, signal) => { seen = signal; res.emit('close'); return { status: 'cancelled' }; } },
    json: (_res, _code, body) => body, readBody: async () => ({ sessionId: 'valid' }) });
  await routes.find(r => r[1] === '/api/companion/decision')[2](res, req);
  assert.equal(seen.aborted, true);
  assert.equal(res.listenerCount('close'), 0);
});
