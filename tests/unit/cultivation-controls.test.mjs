import test from 'node:test';
import assert from 'node:assert/strict';
import {controlFixture, draft, enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';

test('empty read is default-deny and drafts have authenticated immutable authors', async t => {
  const f = await controlFixture(t);
  assert.equal(f.controls.read().data.policy.enabled, false);
  assert.deepEqual(f.controls.read().data.agents, []);
  assert.equal(f.store.read('control').revision, 0);
  const c = f.command('design.submit', {design: draft()});
  await assert.rejects(f.execute(c), /identity_denied/);
  const saved = await f.execute(c, 'mother');
  const row = f.controls.read().data.designs[0];
  assert.equal(row.id, saved.result.id);
  assert.equal(row.author.actorId, 'fixture-mother');
  assert.equal(row.author.originId, 'fixture-run');
  assert.equal(f.controls.read().data.agents.length, 0);
  await assert.rejects(f.execute(f.command('agent.register', {designId: row.id}), 'mother'), /policy_disabled/);
  await assert.rejects(f.execute(f.command('policy.set', {policy: enabledPolicy()}), 'mother'), /identity_denied/);
});

test('request retries are idempotent, changed bodies or actors cannot reuse receipts', async t => {
  const f = await controlFixture(t), c = f.command('design.submit', {design: draft()});
  const one = await f.execute(c, 'mother'), again = await f.execute(c, 'mother');
  assert.deepEqual(again, one);
  assert.equal(f.store.read('control').revision, 1);
  await assert.rejects(f.execute({...c, payload: {design: {...draft(), name: 'Other'}}}, 'mother'), /idempotency_conflict/);
  await assert.rejects(f.execute(f.command('design.submit', {design: draft()}, {expectedRevision: 0}), 'mother'), /revision_conflict/);
  const tampered = {...c, approvedBy: 'user'};
  await assert.rejects(f.execute(tampered, 'mother'), /invalid_command/);
});

test('registration is isolated by UUID and durable pause is not a false cancellation success', async t => {
  const f = await controlFixture(t), {agentId, designId} = await f.register();
  assert.match(agentId, /^[a-f0-9-]{36}$/);
  const state = f.controls.read().data;
  assert.equal(state.agents[0].status, 'ready');
  assert.equal(state.intents[0].agentId, agentId);
  assert.equal(f.store.read(agentId).data.initialDesignId, designId);
  const again = await f.execute(f.command('agent.register', {designId}), 'mother');
  assert.notEqual(again.result.id, agentId);
  await f.execute(f.command('agent.pause', {agentId}));
  const reopened = createCultivationStorage({wsRoot: f.root}).read('control').data.agents[0];
  assert.equal(reopened.status, 'paused');
  assert.equal(reopened.cancellation, 'pending_confirmation');
  assert.equal(reopened.dispatchAllowed, false);
  await assert.rejects(f.execute(f.command('agent.resume', {agentId}), 'mother'), /identity_denied/);
  await f.execute(f.command('policy.set', {policy: {...enabledPolicy(), enabled: false}}));
  await assert.rejects(f.execute(f.command('agent.resume', {agentId})), /policy_disabled/);
  await f.execute(f.command('agent.archive', {agentId}));
  assert.equal(f.controls.read().data.agents[0].status, 'archived');
  await assert.rejects(f.execute(f.command('agent.resume', {agentId})), /invalid_transition/);
});

test('revision and rollback retain history and reject permissions or foreign design lineage', async t => {
  const f = await controlFixture(t), {agentId, designId} = await f.register();
  const changed = {...draft(), name: 'Revision two'};
  const revision = await f.execute(f.command('design.revise', {parentId: designId, design: changed}), 'mother');
  assert.equal(f.controls.read().data.designs.length, 2);
  await f.execute(f.command('agent.adopt', {agentId, designId: revision.result.id}), 'mother');
  assert.equal(f.controls.read().data.agents[0].designId, revision.result.id);
  await f.execute(f.command('agent.pause', {agentId}));
  await f.execute(f.command('agent.rollback', {agentId, designId}));
  const agent = f.controls.read().data.agents[0];
  assert.equal(agent.designId, designId);
  assert.equal(agent.status, 'paused');
  assert.deepEqual(agent.history, [designId, revision.result.id, designId]);
  const unrelated = await f.execute(f.command('design.submit', {design: draft()}), 'mother');
  await assert.rejects(f.execute(f.command('agent.adopt', {agentId, designId: unrelated.result.id}), 'mother'), /design_lineage/);
  await assert.rejects(f.execute(f.command('design.revise', {parentId: designId,
    design: {...draft(), permissions: {...draft().permissions, tools: ['shell']}}}), 'mother'), /permission_expansion/);
});

test('population and malformed business records fail closed', async t => {
  const f = await controlFixture(t), {designId} = await f.register();
  await f.execute(f.command('policy.set', {policy: {...enabledPolicy(), maxAgents: 1}}));
  await assert.rejects(f.execute(f.command('agent.register', {designId}), 'mother'), /population_limit/);
  await f.store.commit('control', {expectedRevision: f.store.read('control').revision,
    actor: 'fixture-corruption', action: 'invalid', data: {policy: enabledPolicy()}});
  assert.throws(() => f.controls.read(), /invalid_control/);
});
