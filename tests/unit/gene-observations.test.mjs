import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateExpression, driftEvidence } from '../../engine/gene-observations.mjs';

const day = 86400000;
const epoch = Date.parse('2026-09-01T00:00:00Z');
const genes = () => ({ gentleness: { baseline: 0.8, expression: 0.99, mutability: 0.06 } });
const context = now => ({ now, sessionId: 'session-a', message: 'source message' });

test('a backward clock neither updates expression nor records evidence', () => {
  const g = genes(), state = { lastObservedAt: null, events: [] };
  updateExpression(g, state, ['user_frustrated'], context(epoch));
  const before = JSON.stringify({ g, state });
  assert.equal(updateExpression(g, state, ['user_frustrated'], context(epoch - day)), false);
  assert.equal(JSON.stringify({ g, state }), before);
});

test('an invalid decision clock cannot authorize an automatic proposal', () => {
  const g = genes(), state = { events: [] };
  for (const offset of [0, day / 2, day]) updateExpression(g, state, ['user_frustrated'], context(epoch + offset));
  assert.equal(driftEvidence(state, 'gentleness', g.gentleness, epoch + day).length, 3);
  for (const now of [NaN, Infinity, -Infinity]) assert.deepEqual(driftEvidence(state, 'gentleness', g.gentleness, now), []);
});

test('updates without a source never manufacture evidence', () => {
  const g = genes(), state = { events: [] };
  for (const offset of [0, day / 2, day]) updateExpression(g, state, ['user_frustrated'], { now: epoch + offset });
  assert.equal(state.events.length, 0);
  assert.deepEqual(driftEvidence(state, 'gentleness', g.gentleness, epoch + day), []);
});

test('observations remain bounded and retain no raw message', () => {
  const g = genes(), state = { events: [] };
  for (let i = 0; i < 600; i++) updateExpression(g, state, ['user_frustrated'], context(epoch + i));
  assert.equal(state.events.length, 500);
  assert.ok(!JSON.stringify(state).includes('source message'));
  updateExpression(g, state, ['user_frustrated'], context(epoch + 31 * day));
  assert.equal(state.events.length, 1);
});
