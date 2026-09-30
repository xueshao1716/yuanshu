import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const moduleUrl = new URL('../../engine/cultivation/identity.mjs', import.meta.url);
async function fixture(overrides = {}) {
  assert.ok(fs.existsSync(moduleUrl), 'identity authority must be implemented');
  const {createIdentityAuthority} = await import(moduleUrl);
  const source = {active: true};
  const authority = createIdentityAuthority({workspace: 'a'.repeat(64), now: () => 1000,
    resolveHuman: s => s === source && s.active ? {actorId: 'human-fixture', originId: 'grant-1'} : null,
    resolveMother: s => s === source && s.active ? {actorId: 'mother-fixture', originId: 'run-1'} : null,
    ...overrides});
  return {authority, source};
}
const command = () => ({requestId: 'fixture-1', action: 'pause', payload: {agentId: 'fixture'}});

test('trusted source issues command-bound principals, never request-body identity', async () => {
  const {authority, source} = await fixture();
  const c = command(), principal = authority.issue('human', source, c);
  const identity = authority.assert(principal, c, ['human']);
  assert.equal(identity.actorId, 'human-fixture');
  assert.equal(identity.originId, 'grant-1');
  assert.equal(identity.workspace, 'a'.repeat(64));
  assert.match(identity.commandHash, /^[a-f0-9]{64}$/);
  assert.throws(() => authority.issue('human', {approvedBy: 'user'}, c), /identity_denied/);
  for (const forged of [{}, {...principal}, structuredClone(principal), {kind: 'human'}])
    assert.throws(() => authority.assert(forged, c, ['human']), /identity_denied/);
  const reordered = {payload: {agentId: 'fixture'}, action: 'pause', requestId: 'fixture-1'};
  assert.deepEqual(authority.assert(principal, reordered, ['human']), identity);
  assert.throws(() => authority.assert(principal, {...c, action: 'resume'}, ['human']), /identity_denied/);
  assert.throws(() => authority.assert(principal, c, ['mother']), /identity_denied/);
});

test('principal is workspace and authority scoped and revoked sources fail revalidation', async () => {
  const {authority, source} = await fixture(), c = command();
  const p = authority.issue('mother', source, c);
  const foreign = await fixture({workspace: 'b'.repeat(64)});
  assert.throws(() => foreign.authority.assert(p, c, ['mother']), /identity_denied/);
  source.active = false;
  assert.throws(() => authority.assert(p, c, ['mother']), /identity_denied/);
});

test('expiry, backwards/invalid clocks, absent and async resolvers fail closed', async () => {
  let clock = 1000;
  const {authority, source} = await fixture({now: () => clock, ttlMs: 100});
  const c = command(), p = authority.issue('human', source, c);
  clock = 1100;
  assert.throws(() => authority.assert(p, c, ['human']), /identity_expired/);
  clock = 999;
  assert.throws(() => authority.assert(p, c, ['human']), /identity_expired/);
  clock = NaN;
  assert.throws(() => authority.issue('human', source, c), /identity_expired/);
  const absent = await fixture({resolveHuman: undefined});
  assert.throws(() => absent.authority.issue('human', {}, c), /identity_unavailable/);
  const asynchronous = await fixture({resolveHuman: async () => ({actorId: 'x', originId: 'y'})});
  assert.throws(() => asynchronous.authority.issue('human', {}, c), /identity_denied/);
});

test('command validation rejects getters without executing them', async () => {
  const {authority, source} = await fixture();
  let ran = 0;
  const c = Object.defineProperty({}, 'action', {enumerable: true, get() { ran++; return 'pause'; }});
  assert.throws(() => authority.issue('human', source, c), /invalid_payload/);
  assert.equal(ran, 0);
});
