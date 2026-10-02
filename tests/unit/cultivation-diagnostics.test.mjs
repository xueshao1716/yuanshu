import test from 'node:test';
import assert from 'node:assert/strict';
import {controlFixture,draft,enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createCultivationProvider} from '../../engine/cultivation/provider.mjs';
import {assertRequest} from '../../engine/cultivation/policy.mjs';
import {cultivationTool} from '../../engine/cultivation/tool.mjs';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createDenialHistory} from '../../engine/cultivation/denials.mjs';
import {createCultivationDiagnostics} from '../../engine/cultivation/diagnostics.mjs';

const runtimeFor=f=>createCultivationRuntime({wsRoot:f.root,now:()=>Date.parse('2026-10-02'),identityAdapters:{
  resolveMother:s=>s===f.mother?{actorId:'fixture-mother',originId:'fixture-run'}:null}});
test('registration with zero execution quotas preserves policy envelope and does not authorize runs',async t=>{
  const f=await controlFixture(t),policy={...enabledPolicy(),dailyRequests:0};
  await f.execute(f.command('policy.set',{policy}));
  const d=draft();d.permissions.costUpperBoundCents=50;
  const design=await f.execute(f.command('design.submit',{design:d}),'mother');
  const result=await f.execute(f.command('agent.register',{designId:design.result.id}),'mother');
  assert.ok(result.result.id);assert.equal(f.controls.read().data.agents[0].dispatchAllowed,false);
  assert.throws(()=>assertRequest(policy,d.permissions),/request_denied/);
  await f.execute(f.command('policy.set',{policy:{...policy,models:[]}}));
  await assert.rejects(f.execute(f.command('agent.register',{designId:design.result.id}),'mother'),/request_denied/);
});
test('read-only preflight aggregates action-specific blockers and cannot register or call providers',async t=>{
  const f=await controlFixture(t),r=runtimeFor(f);
  const d=await r.execute(f.command('design.submit',{design:draft()}),'mother',f.mother);
  const before=f.store.read('control');
  const out=await r.preflight({action:'agent.register',designId:d.result.id});
  assert.equal(out.ready,false);assert.equal(out.retryable,false);
  assert.ok(out.blockedBy.some(b=>b.code==='cultivation_policy_disabled'));
  assert.ok(out.blockedBy.some(b=>b.field==='policy.models'));
  assert.ok(!out.blockedBy.some(b=>/dailyRequests|dailyBudget/.test(b.field)));
  assert.deepEqual(f.store.read('control'),before);
  await assert.rejects(r.preflight({action:'policy.set'}),/invalid_command/);
});
test('trusted rejected writes persist independently without bumping policy revision or granting permissions',async t=>{
  const f=await controlFixture(t),r=runtimeFor(f);
  const d=await r.execute(f.command('design.submit',{design:draft()}),'mother',f.mother);
  const before=f.store.read('control'),c=f.command('agent.register',{designId:d.result.id});
  const out=await cultivationTool(r,c,{executionIdentity:f.mother});
  const detail=JSON.parse(out.text);assert.equal(out.isError,true);assert.equal(detail.retryable,false);
  assert.equal(detail.error,'cultivation_policy_disabled');assert.ok(detail.blockedBy.length>=2);
  assert.equal(detail.audit.recorded,true);
  assert.deepEqual(f.store.read('control'),before);
  const reopened=runtimeFor(f),rows=reopened.denials();assert.equal(rows.items.length,1);
  assert.equal(rows.items[0].requestId,c.requestId);assert.equal(rows.items[0].outcome,'denied');
  assert.equal(JSON.stringify(rows).includes('Synthetic character'),false);
  await assert.rejects(r.execute(c,'mother',{}),/identity_denied/);
  assert.equal(reopened.denials().items.length,1);
  const read=await cultivationTool(r,{action:'preflight',payload:{action:'agent.register',designId:d.result.id}},{executionIdentity:f.mother});
  assert.equal(read.isError,false);assert.equal(JSON.parse(read.text).ready,false);
});
test('provider inspection returns exact text model keys and configuration gaps without provider invocation',async()=>{
  let calls=0;
  const p=createCultivationProvider({catalog:()=>[{provider:'fixture',id:'text',name:'Text',capabilities:{text:true},apiKey:'never-expose'}],directChat:()=>calls++});
  const result=await p.inspect({design:{...draft(),permissions:{...draft().permissions,model:'fixture/text'}},
    policy:enabledPolicy(),sharedPolicy:{allowedModels:[],rates:{},currency:'USD'}});
  assert.equal(result.models[0].key,'fixture/text');assert.equal(result.models[0].health,'not_checked');
  assert.ok(result.blockedBy.some(b=>b.code==='cultivation_model_not_authorized'));
  assert.ok(result.blockedBy.some(b=>b.code==='cultivation_price_unknown'));
  assert.equal(JSON.stringify(result).includes('never-expose'),false);assert.equal(calls,0);
});

test('denial history deduplicates, bounds retention and rejects malformed stored metadata',async t=>{
  const f=await controlFixture(t),h=createDenialHistory({wsRoot:f.root,workspace:f.store.workspace});
  const actor={kind:'mother',commandHash:'a'.repeat(64)},c=f.command('agent.register',{});
  await h.record(c,actor,'cultivation_policy_disabled');await h.record(c,actor,'cultivation_policy_disabled');
  assert.equal(h.list().items[0].count,2);
  for(let i=0;i<202;i++)await h.record({...c,requestId:randomUUID()},actor,'cultivation_policy_disabled');
  assert.equal(h.list().retained,200);assert.equal(h.list().items.length,20);
  const file=`${f.root}/工程/智能体培养/denials.json`,data=JSON.parse(fs.readFileSync(file,'utf8'));
  data.items[0].action='private untrusted content';fs.writeFileSync(file,JSON.stringify(data));
  assert.throws(()=>h.list(),/cultivation_audit_unavailable/);
});

test('preflight fails closed on unavailable shared resources and does not expose catalog exceptions',async t=>{
  const f=await controlFixture(t),{agentId}=await f.register();
  const d=createCultivationDiagnostics({controls:f.controls,execution:{knowledge:{policy:()=>{throw new Error('private-key');}},provider:{inspect:()=>{throw new Error('private-key');}}}});
  const out=await d.preflight({action:'run.submit',agentId});
  assert.equal(out.ready,false);assert.ok(out.blockedBy.some(b=>b.code==='cultivation_diagnostics_unavailable'));
  assert.equal(JSON.stringify(out).includes('private-key'),false);
  const models=await d.models();assert.equal(models.available,false);assert.equal(JSON.stringify(models).includes('private-key'),false);
});

test('free priced models retain zero-budget support while invalid token limits are diagnosed',async()=>{
  const p=createCultivationProvider({catalog:()=>[{provider:'fixture',id:'text',capabilities:{text:true}}],directChat:()=>assert.fail('no provider')});
  const input={design:{...draft(),permissions:{...draft().permissions,model:'fixture/text',remote:true}},policy:{...enabledPolicy(),models:['fixture/text'],allowRemote:true},
    sharedPolicy:{allowedModels:['fixture/text'],rates:{'fixture/text':{input:0,output:0,free:true,currency:'USD',tokenBound:'utf8-bytes'}},currency:'USD',inputTokens:8000,outputTokens:200}};
  assert.deepEqual((await p.inspect(input)).blockedBy,[]);
  input.sharedPolicy.outputTokens=0;
  assert.ok((await p.inspect(input)).blockedBy.some(b=>b.code==='cultivation_input_limit'));
});

test('preflight validates targets and detects changing shared policy revisions',async t=>{
  const f=await controlFixture(t),{agentId,designId}=await f.register();let revision=1;
  const d=createCultivationDiagnostics({controls:f.controls,execution:{knowledge:{policy:()=>({revision:revision++,localEnabled:true,remoteEnabled:true,maxModelRequests:1,dailyCost:0})},budget:{status:()=>({modelRequests:0,spent:0,reserved:0})}}});
  await assert.rejects(d.preflight({action:'run.submit',agentId,designId}),/invalid_command/);
  await assert.rejects(d.preflight({action:'run.submit',agentId}),/state_changing/);
});
