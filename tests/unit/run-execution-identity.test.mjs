import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunManager} from '../../engine/run-manager.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createRunEventLog} from '../../engine/run-event-log.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await tick(); }
  assert.fail('execution did not reach expected state');
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-run-identity-'));
  const store = createRunStore({rootDir: root}), eventLog = createRunEventLog({rootDir: root});
  const contexts = [], releases = [];
  let time = Date.now(), workspace = root;
  const manager = createRunManager({store, eventLog, instanceId: 'fixture-host',
    workspaceScope: () => workspace, identityNow: () => time,
    executeChat: async (_req, res, body) => {
      contexts.push(body.__runContext);
      await new Promise(resolve => releases.push(resolve));
      if (options.fail) throw Error('fixture_failure');
      res.end();
    }});
  t.after(async () => {
    manager.dispose(); releases.forEach(resolve => resolve()); await tick();
    eventLog.close(); fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, store, manager, contexts, releases,
    setTime: value => {time = value;}, setWorkspace: value => {workspace = value;},
    async start(body = {}, context = {}) {
      const run = manager.create({sessionId: 'fixture-session', clientRequestId: 'fixture-request',
        message: 'synthetic work', backgroundRecovery: false, ...body}, context);
      await until(() => contexts.length > 0); return run;
    }};
}

test('host mints opaque live execution identity and ignores caller run context', async t => {
  const f = fixture(t), forged = {actorId: 'mother', runId: 'forged'};
  const run = await f.start({__runContext: {executionIdentity: forged}});
  const context = f.contexts[0], source = context.executionIdentity;
  assert.ok(source, 'host execution identity missing');
  assert.notEqual(source, forged); assert.equal(Object.isFrozen(source), true);
  assert.equal(JSON.stringify(source), '{}');
  assert.equal(Object.hasOwn({...context}, 'executionIdentity'), false);
  assert.equal(JSON.stringify(context).includes('executionIdentity'), false);
  assert.deepEqual(f.manager.resolveExecutionIdentity(source), {
    runId: run.id, sessionId: run.sessionId, attempt: 0, workspace: f.root, motherEligible: true,
  });
  for (const fake of [null, forged, {...source}, JSON.parse(JSON.stringify(source)), run.id])
    assert.equal(f.manager.resolveExecutionIdentity(fake), null);
  const copied = f.manager.resolveExecutionIdentity(source); copied.runId = 'tampered';
  assert.equal(f.manager.resolveExecutionIdentity(source).runId, run.id);
  assert.equal(JSON.stringify(f.store.get(run.id)).includes('executionIdentity'), false);
  f.releases[0](); await until(() => f.manager.get(run.id).status === 'completed');
  assert.equal(f.manager.resolveExecutionIdentity(source), null);
});

test('stop revokes before asynchronous work actually returns', async t => {
  const f = fixture(t), run = await f.start(), source = f.contexts[0].executionIdentity;
  assert.ok(source); assert.ok(f.manager.resolveExecutionIdentity(source));
  f.manager.stop(run.id);
  assert.equal(f.manager.get(run.id).status, 'stopping');
  assert.equal(f.manager.resolveExecutionIdentity(source), null);
});

test('dispose and exceptional completion revoke execution identity', async t => {
  const f = fixture(t, {fail: true}), run = await f.start(), source = f.contexts[0].executionIdentity;
  assert.ok(source); f.releases[0](); await until(() => f.manager.get(run.id).status === 'failed');
  assert.equal(f.manager.resolveExecutionIdentity(source), null);
  const g = fixture(t); await g.start(); const active = g.contexts[0].executionIdentity;
  assert.ok(g.manager.resolveExecutionIdentity(active)); g.manager.dispose();
  assert.equal(g.manager.resolveExecutionIdentity(active), null);
});

test('deadline, invalid clock and clock rollback permanently revoke execution identity', async t => {
  for (const reason of ['deadline', 'rollback', 'nan', 'infinity', 'later-rollback']) {
    const f = fixture(t); await f.start(); const context = f.contexts[0];
    assert.ok(context.executionIdentity);
    if (reason === 'later-rollback') {
      f.setTime(context.executionDeadlineAt - 1);
      assert.ok(f.manager.resolveExecutionIdentity(context.executionIdentity));
    }
    f.setTime({deadline: context.executionDeadlineAt, rollback: 0, nan: NaN,
      infinity: Infinity, 'later-rollback': context.executionDeadlineAt - 2}[reason]);
    assert.equal(f.manager.resolveExecutionIdentity(context.executionIdentity), null);
    f.setTime(Date.now());
    assert.equal(f.manager.resolveExecutionIdentity(context.executionIdentity), null);
  }
});

test('workspace, session, attempt and owner changes permanently revoke old source', async t => {
  for (const reason of ['workspace', 'session', 'attempt', 'owner']) {
    const f = fixture(t), run = await f.start(), source = f.contexts[0].executionIdentity;
    assert.ok(source);
    if (reason === 'workspace') f.setWorkspace(path.join(f.root, 'other'));
    else if (reason === 'session') f.store.update(run.id, {sessionId: 'another-session'});
    else if (reason === 'attempt') f.store.saveCheckpoint(run.id, {attempt: 1});
    else f.store.update(run.id, {ownerId: 'other-host'});
    assert.equal(f.manager.resolveExecutionIdentity(source), null);
    f.setWorkspace(f.root);
    f.store.update(run.id, {sessionId: run.sessionId, ownerId: run.ownerId, checkpoint: run.checkpoint});
    assert.equal(f.manager.resolveExecutionIdentity(source), null, 'restoring metadata cannot revive a revoked source');
  }
});

test('resume signs a new attempt without reviving prior execution identity', async t => {
  const f = fixture(t), run = await f.start(), old = f.contexts[0].executionIdentity;
  assert.ok(old); f.manager.stop(run.id); f.releases[0]();
  await until(() => f.manager.get(run.id).status === 'stopped');
  f.store.update(run.id, {resumeAvailable: true}); f.manager.resume(run.id);
  await until(() => f.contexts.length === 2);
  const next = f.contexts[1].executionIdentity;
  assert.notEqual(next, old); assert.equal(f.manager.resolveExecutionIdentity(old), null);
  assert.equal(f.manager.resolveExecutionIdentity(next).attempt, 1);
});

test('background, voice and team work are not mother eligible', async t => {
  for (const body of [{origin: 'knowledge'}, {origin: 'cultivation'}, {workflow: 'team-general'},
    {workflow: 'team-video'}, {message: '/team synthetic task'}]) {
    const f = fixture(t); await f.start(body); const source = f.contexts[0].executionIdentity;
    assert.ok(source); assert.equal(f.manager.resolveExecutionIdentity(source).motherEligible, false);
  }
  const f = fixture(t);
  await f.start({}, {voiceTaskAdmission: {resourceKey: 'fixture-voice', maxConcurrency: 1}});
  assert.equal(f.manager.resolveExecutionIdentity(f.contexts[0].executionIdentity).motherEligible, false);
});

test('unsupported origin cannot become mother eligible on resume', async t => {
  const f = fixture(t), run = await f.start({origin: 'cultivation'});
  f.manager.stop(run.id); f.releases[0]();
  await until(() => f.manager.get(run.id).status === 'stopped');
  f.store.update(run.id, {resumeAvailable: true}); f.manager.resume(run.id);
  await until(() => f.contexts.length === 2);
  assert.equal(f.manager.resolveExecutionIdentity(f.contexts[1].executionIdentity).motherEligible, false);
});

test('a durable request that changes to background work permanently revokes mother identity', async t => {
  for (const patch of [{origin: 'knowledge'}, {workflow: 'team-general'}, {message: '/team synthetic work'}]) {
    const f = fixture(t), run = await f.start(), source = f.contexts[0].executionIdentity;
    assert.equal(f.manager.resolveExecutionIdentity(source).motherEligible, true);
    f.store.update(run.id, {request: {...run.request, ...patch}});
    assert.equal(f.manager.resolveExecutionIdentity(source), null);
    f.store.update(run.id, {request: run.request});
    assert.equal(f.manager.resolveExecutionIdentity(source), null);
  }
});

test('a rebuilt manager preserves eligibility restrictions and denies legacy runs without a host marker', async t => {
  for (const reason of ['child', 'legacy', 'changed-request']) {
    const f = fixture(t), run = await f.start(reason === 'child' ? {origin: 'cultivation', motherIdentityEligible: true} : {});
    const old = f.contexts[0].executionIdentity;
    f.manager.stop(run.id); f.releases[0]();
    await until(() => f.manager.get(run.id).status === 'stopped'); f.manager.dispose();
    f.store.update(run.id, {resumeAvailable: true,
      ...(reason === 'legacy' ? {motherIdentityEligible: undefined} : {}),
      ...(reason === 'changed-request' ? {request: {...run.request, origin: 'knowledge'}} : {}),
    });
    const store = createRunStore({rootDir: f.root}), eventLog = createRunEventLog({rootDir: f.root});
    let context, release;
    const next = createRunManager({store, eventLog, instanceId: 'new-host', workspaceScope: () => f.root,
      executeChat: async (_req, res, body) => {
        context = body.__runContext; await new Promise(resolve => {release = resolve;}); res.end();
      }});
    try {
      next.resume(run.id); await until(() => !!context);
      assert.equal(next.resolveExecutionIdentity(old), null);
      assert.equal(next.resolveExecutionIdentity(context.executionIdentity).motherEligible, false, reason);
    } finally {
      next.dispose(); release?.(); await tick(); eventLog.close();
    }
  }
});
