import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionFacts, resolveAction } from '../../engine/companion-facts.mjs';

test('facts expose counts only for other sessions; reading requires paired current-run evidence', async () => {
  let events = [{ seq: 1, type: 'tool', data: { name: 'read', id: 't1', args: { path: 'secret' } } }];
  const runs = [{ id: 'mine', sessionId: 'a', status: 'running' }, { id: 'other-secret', sessionId: 'b', status: 'running', input: 'private' }];
  const source = createCompanionFacts({ manager: { list: () => runs, readAfter: id => { assert.equal(id, 'mine'); return events; } }, now: () => 5000, serverEpoch: 'test' });
  const a = await source.read('a');
  assert.equal(a.reading, true); assert.equal(a.otherBusy, 1);
  assert.ok(!JSON.stringify(a).includes('secret'));
  assert.equal((await source.read('a')).revision, a.revision);
  assert.equal(resolveAction(a, { action: 'resting' }), 'reading');
  events = [...events, { seq: 2, type: 'tool_end', data: { id: 't1', name: 'read' } }];
  const b = await source.read('a');
  assert.equal(b.reading, false); assert.notEqual(a.revision, b.revision);
  assert.equal(resolveAction(b, { action: 'resting' }), 'working');
  runs[0].status = 'completed';
  assert.equal(resolveAction(await source.read('a'), { action: 'resting' }), 'working');
  runs[1].status = 'completed';
  assert.equal(resolveAction(await source.read('a'), { action: 'resting' }), 'resting');
});

test('unknown is not idle; unpaired read and shell names do not invent reading', async () => {
  assert.equal(resolveAction({ known: true, currentBusy: false, otherBusy: 0 }, { action: 'reading' }), 'neutral');
  assert.equal(resolveAction({ known: true, currentBusy: false, otherBusy: 0 }, { action: 'working' }), 'neutral');
  assert.equal(resolveAction({ known: false }, { action: 'resting' }), 'neutral');
  const facts = createCompanionFacts({ manager: { list: () => { throw Error('offline'); } } });
  assert.equal((await facts.read('a')).known, false);
  const valid = createCompanionFacts({ manager: { list: () => [{ id: 'r', sessionId: 'a', status: 'running' }], readAfter: () => [{ seq: 1, type: 'tool', data: { name: 'bash', input: 'cat file' } }] } });
  assert.equal((await valid.read('a')).reading, false);
});

test('facts use asynchronous activity observations, never the full synchronous history scan', async () => {
  const manager = { list: () => { throw Error('must not scan'); }, listActivity: async () => [{ id: 'r', sessionId: 'a', status: 'running' }], readAfter: () => [] };
  const facts = createCompanionFacts({ manager });
  assert.equal((await facts.read('a')).currentBusy, true);
  manager.listActivity = async () => { throw Error('unreadable'); };
  assert.equal((await facts.read('a')).known, false);
});
