import test from 'node:test';
import assert from 'node:assert/strict';
const { createTeamApi } = await import('../../engine/team-api.mjs').catch(() => ({}));

test('team API requires explicit task/session/request id and routes bound controls through run manager', async () => {
  assert.equal(typeof createTeamApi, 'function');
  const calls = [];
  const launch = { id: 'l1', runId: 'r1', sessionId: 's1', status: 'running' };
  const api = createTeamApi({ launcher: { status: () => launch, stop: () => { throw Error('unmanaged stop'); } },
    runApi: { create: (_res, body) => calls.push(body), stop: (_res, id) => calls.push(id), resume: (_res, id) => calls.push(id) },
    json: (_res, status, body) => ({ status, body }) });
  assert.equal((await api.start(null, null, {})).status, 400);
  await api.start(null, null, { task: '写10秒脚本', sessionId: 's1', clientRequestId: 'c1' });
  assert.equal(calls[0].workflow, 'team-video');
  assert.equal(calls[0].message, '写10秒脚本');
  assert.equal((await api.stop(null, null, { id: 'wrong' })).status, 409);
  await api.stop(null, null, { id: 'l1' });
  await api.resume(null, null, { id: 'l1' });
  assert.deepEqual(calls.slice(1), ['r1', 'r1']);
});
