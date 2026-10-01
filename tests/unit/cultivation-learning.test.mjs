import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {controlFixture,enabledPolicy,draft} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';

async function authorizedFixture(t){
  const f=await controlFixture(t);
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),dataScopes:['knowledge:approved-cultivation']}}));
  const submitted=await f.execute(f.command('design.submit',{design:{...draft(),
    permissions:{...draft().permissions,dataScopes:['knowledge:approved-cultivation']}}}),'mother');
  const registered=await f.execute(f.command('agent.register',{designId:submitted.result.id}),'mother');
  return {...f,agentId:registered.result.id};
}

test('learning commands recheck live identity, enforce owner and never trust caller actors',async t=>{
  const f=await authorizedFixture(t),{agentId}=f;let calls=0;
  const learning={async decide(input,actor,{guard}){guard();calls++;return {id:input.jobId,revision:2};},
    context:async()=>({entries:[],context:''})};
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveMother:s=>s===f.mother&&s.active?
    {actorId:'fixture-mother',originId:'fixture-run'}:null},learning,learningJob:async()=>({provenance:{agentId}})});
  const c=f.command('learning.decide',{jobId:'a'.repeat(64),scope:agentId,decision:'adopt',reason:'Independent result'});
  assert.equal((await runtime.execute(c,'mother',f.mother)).revision,2);assert.equal(calls,1);
  await f.execute(f.command('policy.set',{policy:enabledPolicy()}));
  await assert.rejects(runtime.execute(c,'mother',f.mother),/data_not_authorized/);
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),dataScopes:['knowledge:approved-cultivation']}}));
  await assert.rejects(runtime.execute({...c,payload:{...c.payload,scope:randomUUID()}},'mother',f.mother),/identity_denied/);
  await assert.rejects(runtime.execute({...c,payload:{...c.payload,actor:{kind:'human'}}},'mother',f.mother),/invalid_command/);
  f.mother.active=false;await assert.rejects(runtime.execute(c,'mother',f.mother),/identity_denied/);
});

test('mother learning read is scoped to owned authorized children and rechecks live identity',async t=>{
  const f=await authorizedFixture(t),{agentId}=f;let received;
  let revoke=false;
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveMother:s=>s===f.mother&&s.active?
    {actorId:'fixture-mother',originId:'fixture-run'}:null},learning:{context:async input=>{
      received=input;if(revoke)f.mother.active=false;return {entries:[],context:'approved'};
    }}});
  const c={action:'learning.context',payload:{query:'Network'}};
  assert.equal((await runtime.readMother(c,f.mother)).context,'approved');
  assert.deepEqual(received.agentIds,[agentId]);assert.equal(received.scope,'mother');
  revoke=true;await assert.rejects(runtime.readMother(c,f.mother),/identity_denied/);
});

test('mother-scoped transfer requires a human grant and cannot be self-authorized',async t=>{
  const f=await controlFixture(t),{agentId}=await f.register();
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveMother:s=>s===f.mother?
    {actorId:'fixture-mother',originId:'fixture-run'}:null},learning:{decide:()=>assert.fail('must not adopt')},
    learningJob:async()=>({provenance:{agentId}})});
  await assert.rejects(runtime.execute(f.command('learning.decide',{jobId:'a'.repeat(64),scope:'mother',decision:'adopt',reason:'Share'}),'mother',f.mother),/identity_denied/);
});

test('explicit mother learning policy is bounded, revocable and fenced across await',async t=>{
  const f=await authorizedFixture(t);let received,withdraw=false;
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),motherLearning:true,dataScopes:['knowledge:approved-cultivation']}}));
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveMother:s=>s===f.mother&&s.active?
    {actorId:'fixture-mother',originId:'fixture-run'}:null},learningJob:async()=>({provenance:{agentId:f.agentId}}),
    learning:{async decide(input,actor,options){received=options;options.guard();
      if(withdraw)await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),dataScopes:['knowledge:approved-cultivation']}}));
      options.guard();return {revision:2};},context:async input=>{received=input;return {entries:[],context:''};}}});
  const c=f.command('learning.decide',{jobId:'b'.repeat(64),scope:'mother',decision:'adopt',reason:'Validated ordinary knowledge'});
  assert.equal((await runtime.execute(c,'mother',f.mother)).revision,2);
  assert.deepEqual(received.motherAuthorization,{mode:'policy',revision:f.controls.read().revision});
  await runtime.readMother({action:'learning.context',payload:{query:'Network'}},f.mother);
  assert.equal(received.motherActorId,'fixture-mother');assert.equal(received.motherLearning,true);
  withdraw=true;await assert.rejects(runtime.execute(c,'mother',f.mother),/policy_changed|identity_denied/);
  await assert.rejects(runtime.execute(c,'mother',f.mother),/identity_denied/);
});
