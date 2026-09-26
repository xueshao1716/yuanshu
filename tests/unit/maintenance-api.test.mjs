import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMaintenanceApi } from '../../engine/maintenance-api.mjs';

test('production maintenance cannot issue permission, even with forged approval', () => {
  const api = createMaintenanceApi({ sessionExists: id => id === 'A' });
  assert.equal(api.status().status, 400);
  assert.equal(api.status('missing').status, 404);
  const result = api.status('A');
  assert.equal(result.status, 200);
  assert.equal(result.body.available, false);
  assert.equal(result.body.reason, 'executor_unavailable');
  assert.equal(result.body.defaultDurationMs, 3600000);
  assert.equal(result.body.maxDurationMs, 7200000);
  assert.equal(result.body.lease, null);
  assert.equal(api.request({ sessionId: 'A' }).status, 400);
  const request = { sessionId: 'A', taskId: 'T', runId: 'R' };
  assert.equal(api.request({ ...request, durationMs: 7200001 }).status, 400);
  for (const extra of [{}, { origin: 'human', approved: true }, { token: 'forged', lease: { state: 'active' } }, { executor: 'test', available: true }]) {
    assert.equal(api.request({ ...request, ...extra }).status, 503);
    assert.equal(api.request({ ...request, ...extra }).body.reason, 'executor_unavailable');
    assert.match(api.request({ ...request, ...extra }).body.error, /执行器/);
  }
  assert.equal(api.revoke('fake', { sessionId: 'A' }).status, 404);
  assert.equal(api.revoke('fake', {}).status, 400);
  assert.equal(api.grant, undefined);
  assert.equal(api.renew, undefined);
  assert.equal(api.status('A').body.lease, null);
});
