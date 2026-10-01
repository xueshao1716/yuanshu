import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';
import {createBackgroundAdmission} from '../../engine/background-admission.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {commandFor} from '../../engine/cultivation/api.mjs';

test('human recovery binds abandoned slot, revision, command and durable receipt',async t=>{
  const f=await controlFixture(t);let terminated=false,active=true;
  const admission=createBackgroundAdmission({wsRoot:f.root,resolveTermination:s=>terminated?{id:s.id,terminated:true}:null});
  const slot=await admission.acquire('cultivation');
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{
    resolveHuman:s=>s===f.human&&active?{actorId:'owner',originId:'proof'}:null,
    resolveMother:s=>s===f.mother?{actorId:'mother',originId:'run'}:null,
  },execution:{admission}});
  const c=f.command('resources.reconcile',{slotId:slot.id,reason:'Verified owner process ended'});
  await assert.rejects(runtime.execute(c,'mother',f.mother),/identity_denied/);
  await assert.rejects(runtime.execute(c,'human',f.human),/recovery_unavailable/);
  assert.equal((await admission.status()).state,'held');
  terminated=true;
  await assert.rejects(runtime.execute({...c,expectedRevision:1},'human',f.human),/revision_conflict/);
  const result=await runtime.execute(c,'human',f.human);
  assert.equal(result.recovered,true);assert.equal((await admission.status()).state,'idle');
  assert.equal(result.receipt.reason,c.payload.reason);assert.equal(result.receipt.budget,'unchanged');
  assert.equal(result.receipt.externalOutcome,'unknown');
  assert.deepEqual(await runtime.execute(c,'human',f.human),result);
  const next=await admission.acquire('knowledge');
  await assert.rejects(runtime.execute({...c,payload:{...c.payload,slotId:next.id}},'human',f.human),/idempotency_conflict/);
  active=false;
  await assert.rejects(runtime.execute(c,'human',f.human),/identity_denied/);
  assert.equal((await admission.status()).id,next.id);
});

test('recovery rechecks live authorization after host evidence awaits',async t=>{
  const f=await controlFixture(t);let active=true;
  const admission=createBackgroundAdmission({wsRoot:f.root,resolveTermination:async s=>{active=false;return {id:s.id,terminated:true};}});
  const slot=await admission.acquire('knowledge');
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveHuman:()=>active?{actorId:'owner',originId:'proof'}:null},execution:{admission}});
  await assert.rejects(runtime.execute(f.command('resources.reconcile',{slotId:slot.id,reason:'Owner exited'}),'human',{}),/identity_denied/);
  assert.equal((await admission.status()).state,'held');
});

test('signed recovery route accepts only command envelope',()=>{
  const body={requestId:randomUUID(),expectedRevision:0,payload:{slotId:randomUUID(),reason:'Host exited'}};
  assert.equal(commandFor('POST','/resources/reconcile',body).action,'resources.reconcile');
});
