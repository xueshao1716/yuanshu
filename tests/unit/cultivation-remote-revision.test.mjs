import test from 'node:test';
import assert from 'node:assert/strict';
import {controlFixture,draft,enabledPolicy} from '../helpers/cultivation-fixture.mjs';

test('remote expansion requires active policy matching the entire request',async t=>{
  for(const patch of [{enabled:false},{expiresAt:'2020-01-01'},{models:[]},{dailyRequests:0}]) {
    const f=await controlFixture(t);
    await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),allowRemote:true,...patch}}));
    const d=draft(),parent=await f.execute(f.command('design.submit',{design:d}),'mother');
    d.permissions.remote=true;
    await assert.rejects(f.execute(f.command('design.revise',{parentId:parent.result.id,design:d}),'mother'),/cultivation_(policy_disabled|policy_expired|request_denied)/);
    assert.equal(f.store.read('control').data.designs.length,1);
  }
});
test('approved remote-only revision can be adopted and history remains readable after revocation',async t=>{
  const f=await controlFixture(t),{agentId,designId}=await f.register();
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),allowRemote:true}}));
  const d=draft();d.permissions.remote=true;
  const next=await f.execute(f.command('design.revise',{parentId:designId,design:d}),'mother');
  await f.execute(f.command('agent.adopt',{agentId,designId:next.result.id}),'mother');
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),enabled:false}}));
  assert.equal(f.controls.read().data.agents[0].designId,next.result.id);
  d.permissions.tools=['shell'];
  await assert.rejects(f.execute(f.command('design.revise',{parentId:next.result.id,design:d}),'mother'),/permission_expansion/);
});
