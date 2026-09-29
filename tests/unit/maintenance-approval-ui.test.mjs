import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../../engine/tools/confirm-registry.mjs';
import { isLocalMaintenanceApproval } from '../../engine/maintenance-approval.mjs';

test('maintenance approval rejects remote and forwarded requests', () => {
  const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' } };
  assert.equal(isLocalMaintenanceApproval(local), true);
  assert.equal(isLocalMaintenanceApproval({ ...local, socket: { remoteAddress: '192.168.1.2' } }), false);
  for (const headers of [{ ...local.headers, 'x-forwarded-for': '1.2.3.4' }, { host: 'pi.example.com' }, { ...local.headers, origin: 'https://evil.test' }]) {
    assert.equal(isLocalMaintenanceApproval({ ...local, headers }), false);
  }
});

test('pending approval can be recovered by session and disappears after denial', async () => {
  const a = registry.register('approval-ui-A', { toolName: 'maintenance', taskId: 'T', runId: 'R' });
  const b = registry.register('approval-ui-B', { toolName: 'maintenance' });
  try {
    const pending = registry.list().filter(item => item.sessionId === 'approval-ui-A');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, a.id);
    assert.ok(pending[0].expiresAt > Date.now());
    registry.settle('approval-ui-A', a.id, false);
    assert.equal(await a.promise, 'rejected');
    assert.equal(registry.list().filter(item => item.sessionId === 'approval-ui-A').length, 0);
  } finally { registry.cancelAll('approval-ui-A'); registry.cancelAll('approval-ui-B'); }
});
