import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {draft} from '../helpers/cultivation-fixture.mjs';
import {hostFixture, tick} from '../helpers/cultivation-host-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createIdentityAuthority} from '../../engine/cultivation/identity.mjs';
import {createCultivationApi} from '../../engine/cultivation/api.mjs';

test('only an exact live execution bound to the actual mother session resolves', async t => {
  const f = await hostFixture(t);
  assert.equal(f.resolve(), null);
  assert.equal(f.adapter.bind(f.source, f.binding), true);
  assert.deepEqual(f.resolve(), {actorId: `mother:${f.storage.workspace}`, originId: `run:${f.run.id}:attempt:0`});
  for (const fake of [{...f.source}, JSON.parse(JSON.stringify(f.source)), f.run.id, null, {actorId: 'mother'}]) {
    assert.equal(f.adapter.bind(fake, f.binding), false);
    assert.equal(f.adapter.resolveMother(fake, f.resolverContext), null);
  }
  assert.equal(f.adapter.resolveMother(f.source, {...f.resolverContext, kind: 'human'}), null);
  assert.equal(f.adapter.resolveMother(f.source, {...f.resolverContext, workspace: '0'.repeat(64)}), null);
});

test('binding rejects wrong session, entry or generation and non-busy sessions', async t => {
  for (const reason of ['session', 'entry', 'generation', 'idle']) {
    const f = await hostFixture(t), binding = {...f.binding};
    if (reason === 'session') binding.sessionId = 'another-session';
    if (reason === 'entry') binding.entry = {...f.entry};
    if (reason === 'generation') binding.generation++;
    if (reason === 'idle') f.entry.busy = false;
    assert.equal(f.adapter.bind(f.source, binding), false, reason);
    assert.equal(f.resolve(), null);
  }
});

test('a live run from a different workspace cannot bind to a local mother session', async t => {
  const other = await hostFixture(t);
  const f = await hostFixture(t, {runWorkspace: other.root});
  assert.ok(f.manager.resolveExecutionIdentity(f.source));
  assert.equal(f.adapter.bind(f.source, f.binding), false);
  assert.equal(f.resolve(), null);
});

test('session replacement, new generation, manager replacement and idle revoke permanently', async t => {
  for (const reason of ['entry', 'generation', 'sm', 'idle']) {
    const f = await hostFixture(t), originalSm = f.entry.sm;
    assert.equal(f.adapter.bind(f.source, f.binding), true); assert.ok(f.resolve());
    if (reason === 'entry') f.entries.set(f.binding.sessionId, {...f.entry});
    if (reason === 'generation') f.entry.gen++;
    if (reason === 'sm') f.entry.sm = {...originalSm};
    if (reason === 'idle') f.entry.busy = false;
    assert.equal(f.resolve(), null, reason);
    f.entries.set(f.binding.sessionId, f.entry); f.entry.gen = 1; f.entry.busy = true; f.entry.sm = originalSm;
    assert.equal(f.resolve(), null, 'revoked binding never revives');
    assert.equal(f.adapter.bind(f.source, f.binding), false, 'same execution cannot rebind');
  }
});

test('session evidence is checked on use; deleted or worker origins cannot authorize', async t => {
  for (const reason of ['deleted', 'voice', 'foreign-workspace']) {
    const f = await hostFixture(t); assert.equal(f.adapter.bind(f.source, f.binding), true);
    if (reason === 'deleted') fs.unlinkSync(f.file);
    if (reason === 'voice') {f.rows.push({type: 'custom', customType: 'voice-task-origin', data: {}}); f.writeSession();}
    if (reason === 'foreign-workspace') {f.rows[0].cwd = f.root + '/other'; f.writeSession();}
    assert.equal(f.resolve(), null, reason);
    f.rows.splice(1); f.rows[0].cwd = f.root; f.writeSession();
    assert.equal(f.resolve(), null);
  }
});

test('background, child, team and voice executions never bind as mother', async t => {
  for (const options of [{body: {origin: 'knowledge'}}, {body: {origin: 'cultivation'}},
    {body: {workflow: 'team-general'}}, {body: {message: '/team synthetic task'}},
    {context: {voiceTaskAdmission: {resourceKey: 'fixture-voice', maxConcurrency: 1}}}]) {
    const f = await hostFixture(t, options);
    assert.equal(f.adapter.bind(f.source, f.binding), false); assert.equal(f.resolve(), null);
  }
});

test('stopping a run invalidates already-issued cultivation principals', async t => {
  const f = await hostFixture(t); f.adapter.bind(f.source, f.binding);
  const authority = createIdentityAuthority({workspace: f.storage.workspace, resolveMother: f.adapter.resolveMother});
  const command = {action: 'design.submit', payload: {synthetic: true}};
  const principal = authority.issue('mother', f.source, command);
  assert.equal(authority.assert(principal, command, ['mother']).originId, `run:${f.run.id}:attempt:0`);
  f.manager.stop(f.run.id);
  assert.throws(() => authority.assert(principal, command, ['mother']), /identity_denied/);
  f.release(); await tick(); assert.equal(f.resolve(), null);
});

test('origin checker failures and asynchronous results deny without leaking failures', async t => {
  for (const canAccess of [() => {throw Error('private-detail');}, async () => {throw Error('private-detail');}]) {
    const f = await hostFixture(t, {canAccess});
    f.adapter.bind(f.source, f.binding); assert.equal(f.resolve(), null); await tick();
  }
});

test('mother-only adapter can submit designs but cannot authorize policy or HTTP mutations', async t => {
  const f = await hostFixture(t); f.adapter.bind(f.source, f.binding); assert.ok(f.resolve());
  const runtime = createCultivationRuntime({wsRoot: f.root, identityAdapters: {resolveMother: f.adapter.resolveMother}});
  assert.equal((await runtime.overview()).writeIdentityAvailable, false);
  const command = {action: 'design.submit', requestId: randomUUID(), expectedRevision: 0, payload: {design: draft()}};
  await assert.rejects(runtime.execute(command, 'human', f.source), /identity_unavailable/);
  const submitted = await runtime.execute(command, 'mother', f.source);
  assert.equal(submitted.revision, 1);
  assert.equal((await runtime.overview()).policy.enabled, false);
  let reads = 0;
  const api = createCultivationApi({runtime, requireAuth: () => true,
    readBody: () => {reads++; return {approvedBy: 'human'};}, json: (res, status, body) => Object.assign(res, {status, body})});
  for (const [method, route] of [['PUT', '/policy'], ['POST', '/designs'], ['POST', '/agents'],
    ['POST', '/agents/fixture/pause'], ['POST', '/runs'], ['POST', '/experience']]) {
    const res = {}; await api.handle({method}, res, new URL(`http://local/api/cultivation${route}`));
    assert.equal(res.status, 503); assert.equal(res.body.error, 'cultivation_identity_unavailable');
  }
  assert.equal(reads, 0); assert.equal(f.storage.read('control').revision, 1);
});
