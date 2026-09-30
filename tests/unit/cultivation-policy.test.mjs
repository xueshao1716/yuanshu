// tests/unit/cultivation-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPolicy, validatePolicy, assertRequest} from '../../engine/cultivation/policy.mjs';

const now = Date.parse('2026-09-30T12:00:00Z');
const active = () => ({...defaultPolicy(), enabled: true,
  expiresAt: '2026-10-01T12:00:00Z', dailyRequests: 2,
  models: ['fixture-local'], tools: ['fixture-read'], dataScopes: ['fixture-public']});
const request = () => ({model: 'fixture-local', tools: ['fixture-read'],
  dataScopes: ['fixture-public'], remote: false, costUpperBoundCents: 0});

test('默认关闭、独立数组、零预算，不继承权限', () => {
  const p = defaultPolicy();
  assert.equal(p.enabled, false);
  assert.equal(p.maxAgents, 3);
  assert.equal(p.maxConcurrent, 1);
  assert.equal(p.dailyBudgetCents, 0);
  assert.equal(p.allowRemote, false);
  assert.equal(p.recursive, false);
  p.models.push('mutated');
  assert.deepEqual(defaultPolicy().models, []);
  assert.throws(() => assertRequest(defaultPolicy(), request(), now), /policy_disabled/);
});

test('拒绝未知字段、递归、无效额度、无期限启用和空白名单项', () => {
  for (const patch of [{approvedBy: 'human'}, {recursive: true}, {dailyBudgetCents: NaN},
    {maxAgents: 0}, {maxConcurrent: 4}, {models: ['']}, {dailyRequests: -1},
    {enabled: true}, {currency: 'unconfigured'}, {models: Array(1)}]) {
    assert.throws(() => validatePolicy({...defaultPolicy(), ...patch}), /invalid_policy/);
  }
  const p = active();
  const copy = validatePolicy(p);
  copy.tools.push('changed');
  assert.deepEqual(p.tools, ['fixture-read']);
});

test('静态请求检查拒绝过期、越权、未知费用和超额', () => {
  assert.equal(assertRequest(active(), request(), now), true);
  assert.throws(() => assertRequest(active(), request(), now + 2 * 86400000), /policy_expired/);
  for (const patch of [{model: 'other'}, {tools: ['shell']}, {dataScopes: ['private']},
    {remote: true}, {costUpperBoundCents: null}, {costUpperBoundCents: 1},
    {tools: 'fixture-read'}, {tools: Array(1)}]) {
    assert.throws(() => assertRequest(active(), {...request(), ...patch}, now), /request_denied/);
  }
  assert.throws(() => assertRequest({...active(), dailyRequests: 0}, request(), now), /request_denied/);
});
