import test from 'node:test';
import assert from 'node:assert/strict';
import {controlFixture,draft,enabledPolicy,overEnvelopePolicy} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeBudget} from '../../engine/knowledge-budget.mjs';
import {createBackgroundAdmission} from '../../engine/background-admission.mjs';

test('mother can self-enable the bounded preset, but an envelope-breaking policy still needs a human',async t=>{
  const f=await controlFixture(t),runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{
    resolveMother:s=>s===f.mother?{actorId:'fixture-mother',originId:'fixture-run'}:null}});
  const result=await runtime.execute(f.command('design.submit',{design:draft()}),'mother',f.mother);
  assert.ok(result.result.id);assert.equal((await runtime.overview()).writeIdentityAvailable,false);
  // 2026-10-18 产品决定：封套内（enabledPolicy 的 2027-01-01 距今天 180 天内）母亲可自行开启。
  await runtime.execute(f.command('policy.set',{policy:enabledPolicy()}),'mother',f.mother);
  // 越线（有效期超出 180 天）仍需人类确认。
  await assert.rejects(runtime.execute(f.command('policy.set',{policy:overEnvelopePolicy()}),'mother',f.mother),/identity_denied/);
});

test('runtime composes bounded execution, knowledge reconciliation and real projections',async t=>{
  const f=await controlFixture(t),{agentId}=await f.register(),now=()=>Date.parse('2026-09-30T12:00:00Z');
  await f.execute(f.command('policy.set',{policy:{...enabledPolicy(),dailyRequests:2,schedule:{timezone:'UTC',days:[3],startMinute:0,endMinute:1440}}}));
  const knowledge=createKnowledgeStore({wsRoot:f.root,now}),budget=createKnowledgeBudget({wsRoot:f.root,now});
  await knowledge.updatePolicy({remoteEnabled:true,maxModelRequests:10},1);
  const runtime=createCultivationRuntime({wsRoot:f.root,now,identityAdapters:{
    resolveMother:s=>s===f.mother?{actorId:'fixture-mother',originId:'fixture-run'}:null,
    resolveHuman:s=>s===f.human?{actorId:'fixture-user',originId:'fixture-grant'}:null},
    execution:{knowledge,budget,admission:createBackgroundAdmission({wsRoot:f.root,now}),
      provider:{prepare:async()=>({maxCost:0,currency:'USD',free:true,remote:false}),
        invoke:async()=>({text:'Synthetic output',usage:{cost:0,currency:'USD'}}),
        verifyPrepare:async()=>({maxCost:0,currency:'USD',free:true,remote:false}),
        verifyInvoke:async()=>({usage:{cost:0,currency:'USD'},
          verification:{verdict:'pass',evidence:['Synthetic'],gaps:[],conditions:'仅限本输入',confidence:'high',grounded:true}})}}});
  const overview=await runtime.overview();assert.equal(overview.executorAvailable,true);
  const submitted=await runtime.execute(f.command('run.submit',{agentId,input:'Synthetic',goal:'Check',criterion:'Independent evidence'}),'mother',f.mother);
  await runtime.tick();
  assert.equal((await runtime.list('runs')).items[0].id,submitted.result.id);
  assert.equal((await runtime.list('experience')).items[0].state,'review_required');
  assert.equal((await runtime.overview()).usage.modelRequests,2);
  await runtime.close();
});
