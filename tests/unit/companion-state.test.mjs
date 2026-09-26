import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../../frontend/src/components/xiaoyu/companion-state.mjs';
const facts = { sessionId: 'a', serverEpoch: 'server', revision: 'r1', known: true, currentBusy: false, otherBusy: 0, reading: false };
const context = { sessionId: 'a', contextEpoch: 'view', facts, now: 1000, visible: true };
const decision = { sessionId: 'a', contextEpoch: 'view', serverEpoch: 'server', basisRevision: 'r1', expiresAt: 2000, action: 'resting' };
test('old session, context, revision, epoch, expiry and hidden decisions are rejected', () => {
  assert.equal(state.acceptDecision(decision, context), true);
  for (const changed of [{ sessionId: 'b' }, { contextEpoch: 'old' }, { serverEpoch: 'old' }, { basisRevision: 'r0' }, { expiresAt: 999 }]) {
    assert.equal(state.acceptDecision({ ...decision, ...changed }, context), false);
  }
  assert.equal(state.acceptDecision(decision, { ...context, visible: false }), false);
  assert.equal(state.acceptDecision(decision, { ...context, facts: null }), false);
});
test('runtime facts override model poses and missing artwork stays explicit', () => {
  assert.equal(state.actionFor({ ...facts, currentBusy: true }, decision), 'working');
  assert.equal(state.actionFor({ ...facts, currentBusy: true, reading: true }, decision), 'reading');
  assert.equal(state.actionFor(null, decision), 'neutral');
  assert.equal(state.actionFor(facts, { action: 'working' }), 'neutral');
  assert.equal(state.actionFor(facts, decision), 'resting');
  assert.equal(state.portraitFor('reading', {}).missing, true);
  assert.equal(state.portraitFor('reading', { reading: { src: '/asset.webp', accepted: false } }).missing, true);
  assert.equal(state.portraitFor('reading', { reading: { src: '/asset.webp', accepted: true } }).missing, false);
});
test('automatic interaction only runs on changed input in a visible enabled view', () => {
  const input = { visible: true, dnd: false, sessionId: 'a', known: true, key: 'changed', previous: 'old' };
  assert.equal(state.shouldAutoDecide(input), true);
  for (const changed of [{ visible: false }, { dnd: true }, { sessionId: null }, { known: false }, { previous: 'changed' }]) assert.equal(state.shouldAutoDecide({ ...input, ...changed }), false);
});

test('subscription acknowledgements do not count as conversation changes', () => {
  assert.equal(state.isConversationEvent({ key: 'session:a', lastSeq: 12 }), false);
  assert.equal(state.isConversationEvent({ type: 'subscribed', lastSeq: 12 }), false);
  assert.equal(state.isConversationEvent({ type: 'message_update', seq: 13 }), true);
  assert.equal(state.isConversationEvent({ type: 'session_updated' }), true);
  assert.equal(state.isConversationEvent(null), false);
});

test('automatic interaction waits while tasks or an interaction are running', () => {
  const input = { visible: true, dnd: false, sessionId: 'a', known: true, key: 'new', previous: 'old' };
  assert.equal(state.shouldAutoDecide({ ...input, pending: true }), false);
  assert.equal(state.shouldAutoDecide({ ...input, currentBusy: true }), false);
});
