import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {controlFixture, draft, enabledPolicy} from '../helpers/cultivation-fixture.mjs';

async function api(t, {trusted = false, resolveRequestIdentity} = {}) {
  const f = await controlFixture(t);
  const url = new URL('../../engine/cultivation/api.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'cultivation API must be implemented');
  const {createCultivationApi} = await import(url);
  const {createCultivationRuntime} = await import('../../engine/cultivation/runtime.mjs');
  const bindings = new WeakMap();
  const runtime = createCultivationRuntime({wsRoot: f.root,
    now: () => Date.parse('2026-09-30'),
    ...(trusted ? {identityAdapters: {
      resolveHuman: s => s === f.human && s.active ? {actorId: 'fixture-user', originId: 'fixture-grant'} : null,
      resolveMother: s => s === f.mother && s.active ? {actorId: 'fixture-mother', originId: 'fixture-run'} : null,
    }} : {})});
  let bodyReads = 0;
  const routes = createCultivationApi({runtime,
    readBody: req => {bodyReads++; return req.body;},
    json: (res, status, body) => Object.assign(res, {status, body}),
    requireAuth: async req => req.headers?.authorization === 'Bearer fixture',
    resolveRequestIdentity: trusted ? resolveRequestIdentity ?? (req => bindings.get(req)) : undefined});
  const call = async (route, method = 'GET', body, auth = true, identity) => {
    const res = {};
    const req = {method, body, headers: auth ? {authorization: 'Bearer fixture'} : {}};
    if (identity) bindings.set(req, identity);
    await routes.handle(req, res, new URL(`http://local/api/cultivation${route}`));
    return res;
  };
  return {...f, call, runtime, bodyReads: () => bodyReads};
}
test('HTTP reads require authentication and cannot initialize storage or execute tasks', async t => {
  const f = await api(t);
  assert.equal((await f.call('/overview?token=fixture', 'GET', undefined, false)).status, 401);
  const response = await f.call('/overview');
  assert.equal(response.status, 200);
  assert.equal(response.body.writeIdentityAvailable, false);
  assert.equal(response.body.executorAvailable, false);
  assert.equal(f.store.read('control').revision, 0);
  assert.equal(f.bodyReads(), 0);
  assert.equal((await f.call('/agents?limit=51')).status, 400);
  assert.equal((await f.call('/unknown')).status, 404);
});

test('trusted host binding authorizes exact routes without accepting request-supplied identities', async t => {
  const f = await api(t, {trusted: true});
  const body = (action, payload) => {const {action: unused, ...rest} = f.command(action, payload); return rest;};
  const human = {kind: 'human', source: f.human}, mother = {kind: 'mother', source: f.mother};
  const policy = body('policy.set', {policy: enabledPolicy()});
  assert.equal((await f.call('/policy', 'PUT', policy)).status, 403);
  assert.equal((await f.call('/policy', 'PUT', policy, true, mother)).status, 403);
  assert.equal((await f.call('/policy', 'PUT', policy, true, human)).status, 200);
  const submission = body('design.submit', {design: draft()});
  const design = await f.call('/designs', 'POST', submission, true, mother);
  assert.equal(design.status, 200);
  assert.deepEqual(await f.call('/designs', 'POST', submission, true, mother), design);
  const agent = await f.call('/agents', 'POST', body('agent.register', {designId: design.body.result.id}), true, mother);
  assert.equal(agent.status, 200);
  const agentId = agent.body.result.id;
  const pause = body('agent.pause', {});
  assert.equal((await f.call(`/agents/${agentId}/pause`, 'POST', {...pause, approvedBy: 'human'}, true, human)).status, 400);
  assert.equal((await f.call(`/agents/${agentId}/pause`, 'POST', {...pause, payload: {agentId}}, true, human)).status, 400);
  assert.equal((await f.call(`/agents/${agentId}/pause`, 'POST', pause, true, human)).status, 200);
  assert.equal((await f.call(`/agents/${agentId}`)).body.agent.status, 'paused');
  f.human.active = false;
  assert.equal((await f.call(`/agents/${agentId}/resume`, 'POST', body('agent.resume', {}), true, human)).status, 403);
});

test('write payload must be an object before any route target is injected', async t => {
  const f = await api(t, {trusted: true}), {agentId} = await f.register();
  const before = f.store.read('control').revision;
  for (const payload of [[], null, '', false, 0]) {
    const {action: unused, ...body} = f.command('agent.pause', payload);
    const response = await f.call(`/agents/${agentId}/pause`, 'POST', body, true, {kind: 'human', source: f.human});
    assert.equal(response.status, 400, `malformed payload ${JSON.stringify(payload)}`);
    assert.equal(response.body.error, 'cultivation_invalid_command');
  }
  assert.equal(f.store.read('control').revision, before);
});

test('identity adapter errors stay private and asynchronous identity is rejected', async t => {
  for (const resolveRequestIdentity of [() => {throw new Error('private fixture path and secret');},
    async () => {throw new Error('private rejected identity');}]) {
    const f = await api(t, {trusted: true, resolveRequestIdentity});
    const {action: unused, ...body} = f.command('policy.set', {policy: enabledPolicy()});
    const response = await f.call('/policy', 'PUT', body);
    assert.ok([403, 503].includes(response.status));
    assert.ok(!JSON.stringify(response).includes('private'));
    assert.equal(f.store.read('control').revision, 0);
  }
});
test('no trusted adapter means all write endpoints deny even valid bearer and forged approval', async t => {
  const f = await api(t), body = {approvedBy: 'user', author: 'mother', confirmed: true};
  for (const route of ['/designs', '/agents', '/agents/fixture/pause', '/runs', '/experience']) {
    const response = await f.call(route, 'POST', body);
    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'cultivation_identity_unavailable');
  }
  assert.equal((await f.call('/policy', 'PUT', body)).status, 503);
  assert.equal(f.bodyReads(), 0);
  assert.equal(f.store.read('control').revision, 0);
});
test('server wires scoped cultivation routes without installing fake write identity', () => {
  const text = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8');
  assert.ok(text.includes('identityAdapters: { resolveMother: cultivationHostIdentity.resolveMother }'));
  const host = text.slice(text.indexOf('const cultivationHostIdentity ='), text.indexOf('const dreamCollector ='));
  assert.ok(host.includes('source => runManager.resolveExecutionIdentity(source)'));
  assert.ok(host.includes('getEntry: id => activeSessions.get(id)'));
  assert.ok(host.includes('canAccess: canAccessSessionOrigin'));
  assert.ok(!host.includes('resolveHuman') && !host.includes('resolveRequestIdentity'));
  const binding = text.indexOf('cultivationHostIdentity.bind(body.__runContext?.executionIdentity,');
  assert.ok(binding > text.indexOf('entry.busySince = Date.now();'));
  assert.ok(text.slice(binding, binding + 220).includes('entry, generation: thisGen'));
  assert.ok(text.includes('cultivationApi.handle(req, res, url)'));
  assert.ok(text.includes("['GET', 'POST', 'PUT']"));
});
