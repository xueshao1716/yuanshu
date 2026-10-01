import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {pageRecords} from '../../engine/cultivation/pagination.mjs';

test('cultivation output becomes one attributed hypothesis, never a claimed knowledge source',async t=>{
  const f=await controlFixture(t),knowledge=createKnowledgeStore({wsRoot:f.root});
  assert.equal(typeof knowledge.offerCultivation,'function');
  const run={id:randomUUID(),sessionId:'fixture',status:'completed',request:{origin:'cultivation'},
    cultivation:{workspace:f.store.workspace,agentId:randomUUID(),designId:randomUUID(),
      output:'Synthetic learning hypothesis',goal:'Check',criterion:'Compare independently'}};
  const job=await knowledge.offerCultivation(run),again=await knowledge.offerCultivation(run);
  assert.equal(job.id,again.id);assert.equal(job.state,'review_required');
  assert.equal(job.candidate.kind,'synthesis');assert.equal(job.provenance.role,'model_generated');
  assert.equal(job.provenance.independentEvidenceCount,0);assert.equal(job.provenance.userAcceptance,null);
  assert.equal((await knowledge.list()).total,1);assert.equal(await knowledge.claim('fixture-worker'),null);
  await assert.rejects(knowledge.control(job.id,'retry',job.revision),/independent_evidence_required/);
  await assert.rejects(knowledge.review(job.id,{decision:'accept_source',confirmed:true,note:'Model says yes'},job.revision,1),/independent_evidence_required/);
  await assert.rejects(knowledge.offerCultivation({...run,cultivation:{...run.cultivation,workspace:'0'.repeat(64)}}),/invalid_source/);
});

test('knowledge bridge reconciles a failed receipt write without duplicating a hypothesis',async t=>{
  const f=await controlFixture(t),knowledge=createKnowledgeStore({wsRoot:f.root});
  const url=new URL('../../engine/cultivation/experience.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'experience bridge exists');
  const {createCultivationExperience}=await import(url);
  const run={id:randomUUID(),sessionId:'fixture',status:'completed',request:{origin:'cultivation'},
    cultivation:{workspace:f.store.workspace,agentId:randomUUID(),designId:randomUUID(),output:'Candidate',goal:'Check',criterion:'Compare'}};
  let fail=true;
  const repo={scan:async function*(){yield structuredClone(run);},page:query=>pageRecords([run],f.store.workspace,'experience',query),get:()=>structuredClone(run),update:(_id,patch)=>{
    if(fail)throw new Error('simulated receipt failure');Object.assign(run,patch);
  }};
  const bridge=createCultivationExperience({repo,knowledge,workspace:f.store.workspace});
  await assert.rejects(bridge.reconcile(),/receipt failure/);assert.equal((await knowledge.list()).total,1);
  fail=false;await bridge.reconcile();await bridge.reconcile();assert.equal((await knowledge.list()).total,1);
  const page=await bridge.list();assert.equal(page.items[0].knowledgeJobId,run.cultivation.knowledgeJobId);
  assert.equal(page.items[0].state,'review_required');assert.equal(page.items[0].evidenceCount,0);
});

test('experience projects one bounded knowledge snapshot instead of rereading per run',async()=>{
  const {createCultivationExperience}=await import('../../engine/cultivation/experience.mjs');
  const {digest}=await import('../../engine/knowledge-state.mjs');
  let reads=0;const runs=Array.from({length:25},()=>({id:randomUUID(),cultivation:{
    agentId:randomUUID(),knowledgeJobId:digest(randomUUID()),output:'Candidate'}}));
  const bridge=createCultivationExperience({repo:{page:query=>pageRecords(runs,'a'.repeat(64),'experience',query)},workspace:'a'.repeat(64),knowledge:{
    get:()=>assert.fail('per-run read'),getMany:async ids=>{reads++;assert.equal(ids.length,20);
      return ids.map(id=>{const r=runs.find(r=>r.cultivation.knowledgeJobId===id);return {id,runId:r.id,state:'review_required',
        provenance:{outputHash:digest(r.cultivation.output)}};});}}});
  assert.equal((await bridge.list({limit:20})).items.length,20);assert.equal(reads,1);
});

test('batch knowledge reads are bounded and returned records are detached',async t=>{
  const f=await controlFixture(t),knowledge=createKnowledgeStore({wsRoot:f.root});
  assert.equal(typeof knowledge.getMany,'function');
  await assert.rejects(knowledge.getMany(Array(51).fill('a'.repeat(64))),/invalid_pagination/);
  assert.deepEqual(await knowledge.getMany(['a'.repeat(64)]),[null]);
});

test('unsuccessful tasks are reconciled honestly with no raw error or invented output',async t=>{
  const f=await controlFixture(t),knowledge=createKnowledgeStore({wsRoot:f.root});
  const {createCultivationExperience}=await import('../../engine/cultivation/experience.mjs');
  for(const [status,reason,outcome] of [['stopped','resource_or_provider_unavailable','not_completed'],
    ['interrupted','outcome_unknown','unknown'],['stopped','cancelled','cancelled'],['stopped','cancel_requested','cancelled'],['failed','private-token-123','failed']]){
    const run={id:randomUUID(),sessionId:'fixture',status,request:{origin:'cultivation'},error:{message:'private-token-123'},
      cultivation:{workspace:f.store.workspace,agentId:randomUUID(),designId:randomUUID(),output:null,reason}};
    const repo={scan:async function*(){yield structuredClone(run);},get:()=>structuredClone(run),
      update:(_id,p)=>Object.assign(run,p),page:q=>pageRecords([run],f.store.workspace,'experience',q)};
    const bridge=createCultivationExperience({repo,knowledge,workspace:f.store.workspace});
    await bridge.reconcile();assert.ok(run.cultivation.knowledgeJobId,'terminal experience recorded');
    await bridge.reconcile();const job=await knowledge.get(run.cultivation.knowledgeJobId);
    assert.equal(job.provenance.outcome,outcome);assert.equal(job.provenance.role,'execution_record');
    assert.equal(job.state,'review_required');assert.ok(!JSON.stringify(job).includes('private-token'));
    const item=(await bridge.list()).items[0];assert.equal(item.role,'execution_record');assert.equal(item.outcome,outcome);
    run.status='completed';run.cultivation.output='Different actual result';
    assert.equal((await bridge.list()).items[0].state,'invalidated');
  }
  assert.equal((await knowledge.list()).total,5);assert.equal(await knowledge.claim('fixture'),null);
});

test('receipt reconciliation does not attach an obsolete result across an asynchronous offer',async t=>{
  const f=await controlFixture(t),knowledge=createKnowledgeStore({wsRoot:f.root});
  const {createCultivationExperience}=await import('../../engine/cultivation/experience.mjs');
  const run={id:randomUUID(),sessionId:'fixture',status:'interrupted',request:{origin:'cultivation'},
    cultivation:{workspace:f.store.workspace,agentId:randomUUID(),designId:randomUUID(),output:null}};
  const offer=knowledge.offerCultivation;let change=true;
  const repo={scan:async function*(){yield structuredClone(run);},get:()=>structuredClone(run),
    update:(_id,p)=>Object.assign(run,p),page:q=>pageRecords([run],f.store.workspace,'experience',q)};
  const bridge=createCultivationExperience({repo,knowledge:{...knowledge,offerCultivation:async source=>{
    const result=await offer(source);
    if(change){run.status='completed';run.cultivation.output='Actual final result';change=false;}
    return result;
  }},workspace:f.store.workspace});
  await bridge.reconcile();assert.equal(run.cultivation.knowledgeJobId,undefined,'obsolete receipt must not attach');
  await bridge.reconcile();const job=await knowledge.get(run.cultivation.knowledgeJobId);
  assert.equal(job.candidate.text,'Actual final result');assert.equal((await bridge.list()).items[0].state,'review_required');
});
