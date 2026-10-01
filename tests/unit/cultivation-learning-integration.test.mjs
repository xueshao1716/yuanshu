import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createKnowledgeRuntime} from '../../engine/knowledge-runtime.mjs';

async function evidence(t){
  const f=await controlFixture(t),runRoot=path.join(f.root,'ledger');
  const r=createKnowledgeRuntime({wsRoot:f.root,runRoot,runStore:createRunStore({rootDir:runRoot}),catalog:()=>[],directChat:()=>assert.fail('no network')});
  t.after(()=>r.close());fs.mkdirSync(path.join(f.root,'docs'));
  const file=path.join(f.root,'docs/source.txt');fs.writeFileSync(file,'网络配置：核对连接状态。');
  const agentId=randomUUID(),job=await r.store.offerCultivation({id:randomUUID(),sessionId:'cultivation:'+agentId,status:'completed',request:{origin:'cultivation'},
    cultivation:{workspace:f.store.workspace,agentId,designId:randomUUID(),output:'网络假设',goal:'Check',criterion:'External evidence'}});
  await r.updatePolicy({allowedRoots:['docs']},1);
  const correction=await r.supplement(job.id,{kind:'file',path:'docs/source.txt'},job.revision,2);
  await r.worker.tick();const review=await r.store.get(correction.id);
  await r.review(correction.id,{decision:'accept_source',confirmed:true,note:'Synthetic source reviewed'},review.revision,2);
  await r.worker.tick();const resolved=await r.store.get(job.id);
  const actor={kind:'human',actorId:'fixture-user',originId:'proof',workspace:f.store.workspace};
  const request={jobId:job.id,scope:'mother',decision:'adopt',reason:'Independent evidence',expectedRevision:resolved.revision,requestId:randomUUID()};
  return {r,file,agentId,actor,request};
}

test('mother transfer consumes only approved owned sources and withdrawal immediately removes context',async t=>{
  const {r,agentId,actor,request}=await evidence(t);
  const [a,b]=await Promise.all([r.cultivationLearning.decide(request,actor),r.cultivationLearning.decide(request,actor)]);
  assert.equal(a.revision,b.revision);assert.equal(b.learning.length,1);
  assert.equal((await r.cultivationLearning.context({scope:'mother',query:'网络',agentIds:[agentId]})).entries.length,1);
  assert.equal((await r.cultivationLearning.context({scope:'mother',query:'网络',agentIds:[randomUUID()]})).entries.length,0);
  assert.equal((await r.cultivationLearning.context({scope:'mother',query:'网络'})).entries.length,0);
  await r.cultivationLearning.decide({...request,requestId:randomUUID(),decision:'retire',expectedRevision:a.revision},actor);
  assert.equal((await r.cultivationLearning.context({scope:'mother',query:'网络',agentIds:[agentId]})).entries.length,0);
});

test('adoption revalidates source bytes after retrieval before committing decision',async t=>{
  const {r,file,actor,request}=await evidence(t),decide=r.store.cultivationDecisions.decide;
  r.store.cultivationDecisions.decide=(...args)=>{fs.writeFileSync(file,'Changed source; old evidence no longer valid.');return decide(...args);};
  await assert.rejects(r.cultivationLearning.decide(request,actor),/independent_evidence_required/);
  assert.equal((await r.store.get(request.jobId)).learning?.length??0,0);
});

test('adoption checks live authority and knowledge policy again at commit',async t=>{
  const {r,actor,request}=await evidence(t),decide=r.store.cultivationDecisions.decide;
  r.store.cultivationDecisions.decide=async(...args)=>{await r.updatePolicy({allowedRoots:[]},2);return decide(...args);};
  await assert.rejects(r.cultivationLearning.decide(request,actor),/policy_changed/);
  assert.equal((await r.store.get(request.jobId)).learning?.length??0,0);
});
