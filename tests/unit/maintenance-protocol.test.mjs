import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAINTENANCE_TTL_MS, MAX_MAINTENANCE_TTL_MS, maintenanceDuration, checkMaintenanceLease, closeMaintenanceLease } from '../../engine/maintenance-protocol.mjs';

const binding = { leaseId: 'L', sessionId: 'A', taskId: 'task', runId: 'run', principalId: 'owner', executorId: 'isolated', policyVersion: 'v1', epoch: 'boot-1', actionDigest: 'sha256:abc', revision: 1 };
// Protocol fixture only: never a production credential or authorization source.
const lease = { ...binding, leaseId: 'L', state: 'active', issuedAt: 1000, expiresAt: 3601000 };
const context = { ...binding, now: 2000, lastObservedAt: 1500, controlPlaneConnected: true };
test('maintenance default is one hour, hard maximum two hours', () => {
  assert.equal(DEFAULT_MAINTENANCE_TTL_MS, 3600000);
  assert.equal(MAX_MAINTENANCE_TTL_MS, 7200000);
  assert.equal(maintenanceDuration(), 3600000);
  assert.equal(maintenanceDuration(7200000), 7200000);
  for (const bad of [0, -1, NaN, Infinity, '3600000', null, 7200001, 1.5]) assert.throws(() => maintenanceDuration(bad));
});
test('lease matches every target, current revision, action and control-plane epoch', () => {
  assert.equal(checkMaintenanceLease(lease, context).ok, true);
  for (const key of Object.keys(binding)) {
    assert.equal(checkMaintenanceLease(lease, { ...context, [key]: key === 'revision' ? 2 : 'other' }).ok, false, key);
    const broken = { ...lease }; delete broken[key];
    assert.equal(checkMaintenanceLease(broken, context).ok, false, `missing ${key}`);
  }
  assert.equal(checkMaintenanceLease(lease, { ...context, controlPlaneConnected: false }).ok, false);
  assert.equal(checkMaintenanceLease(lease, { ...context, now: 1400 }).ok, false);
  assert.equal(checkMaintenanceLease(lease, { ...context, now: lease.expiresAt }).reason, 'expired');
  for (const bad of [null, {}, { ...lease, expiresAt: NaN }, { ...lease, issuedAt: 3000 }, { ...lease, expiresAt: 9000000 }, { ...lease, state: 'requested' }]) {
    assert.equal(checkMaintenanceLease(bad, context).ok, false);
  }
});
test('terminal states cannot revive; revocation invalidates previously queued validation', () => {
  for (const state of ['revoked', 'expired', 'completed']) {
    const closed = closeMaintenanceLease(lease, state);
    assert.equal(checkMaintenanceLease(closed, context).ok, false);
    assert.deepEqual(closeMaintenanceLease(closed, 'revoked'), closed);
    assert.throws(() => closeMaintenanceLease(closed, 'active'));
  }
  assert.equal(closeMaintenanceLease({ ...lease, state: 'requested' }, 'denied').state, 'denied');
  assert.throws(() => closeMaintenanceLease(lease, 'denied'));
  assert.throws(() => closeMaintenanceLease({ ...lease, state: 'requested' }, 'completed'));
  const denied = closeMaintenanceLease({ ...lease, state: 'requested' }, 'denied');
  assert.deepEqual(closeMaintenanceLease(denied, 'revoked'), denied);
  assert.equal(closeMaintenanceLease({ ...lease, state: 'requested' }, 'revoked').state, 'revoked');
  assert.throws(() => closeMaintenanceLease({ ...lease, state: 'requested' }, 'active'));
  assert.equal(checkMaintenanceLease(lease, context).ok, true);
  assert.equal(checkMaintenanceLease(closeMaintenanceLease(lease, 'revoked'), context).ok, false);
});
