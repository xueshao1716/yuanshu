import test from 'node:test';
import assert from 'node:assert/strict';
import {controlData} from '../../engine/cultivation/control-state.mjs';
import {controlFixture, draft} from '../helpers/cultivation-fixture.mjs';

test('business validation rejects damaged ownership, lineage, cancellation and receipt provenance', async t => {
  const f = await controlFixture(t), {agentId, designId} = await f.register();
  const revised = await f.execute(f.command('design.revise', {parentId: designId, design: draft()}), 'mother');
  await f.execute(f.command('agent.adopt', {agentId, designId: revised.result.id}), 'mother');
  const unrelated = await f.execute(f.command('design.submit', {design: draft()}), 'mother');
  const record = f.controls.read();
  const corruptions = [
    d => {d.data.designs[1].author.actorId = 'other-mother';},
    d => {d.data.designs[1].design.permissions.tools = ['shell'];},
    d => {d.data.agents[0].mentorId = 'other-mother';},
    d => {d.data.agents[0].history = [unrelated.result.id, revised.result.id]; d.data.intents[0].designId = unrelated.result.id;},
    d => {d.data.agents[0].status = 'paused'; d.data.agents[0].cancellation = 'not_requested';},
    d => {d.data.receipts[0].actor.actorId = 'other-user';},
    d => {d.audit[0].action = 'agent.pause';},
    d => {d.data.receipts[0].result.id = unrelated.result.id;},
    d => {d.data.designs[0].author.originId = 'other-run';},
  ];
  for (const [index, corrupt] of corruptions.entries()) {
    const damaged = structuredClone(record); corrupt(damaged);
    assert.throws(() => controlData(damaged), /invalid_control/, `corruption ${index}`);
  }
});
