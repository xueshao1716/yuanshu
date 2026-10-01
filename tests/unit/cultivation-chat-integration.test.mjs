import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostFixture} from '../helpers/cultivation-host-fixture.mjs';
import {draft,enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createKnowledgeRuntime} from '../../engine/knowledge-runtime.mjs';
import {cultivationChatContext} from '../../engine/cultivation/chat.mjs';

test('live mother execution adopts independent evidence, uses it in chat and loses access on revocation',async t=>{
  const f=await hostFixture(t);f.adapter.bind(f.source,f.binding);
  initFileLock({dir:path.join(f.root,'locks')});
  const runStore=createRunStore({rootDir:f.root});
  const knowledge=createKnowledgeRuntime({wsRoot:f.root,runRoot:f.root,runStore,
    catalog:()=>[],directChat:()=>assert.fail('no external model call')});
  t.after(()=>knowledge.close());
  const human=Object.freeze({});let clock=Date.now();
  const runtime=createCultivationRuntime({wsRoot:f.root,now:()=>clock,
    identityAdapters:{resolveMother:f.adapter.resolveMother,
      resolveHuman:s=>s===human?{actorId:'test-owner',originId:'test-proof'}:null},
    learning:knowledge.cultivationLearning,learningJob:id=>knowledge.store.get(id)});
  const execute=async(action,payload,kind='mother',revision)=>runtime.execute({action,payload,requestId:randomUUID(),
    expectedRevision:revision??(await runtime.overview()).revision},kind,kind==='human'?human:f.source);
  const policy={...enabledPolicy(),motherLearning:true,dataScopes:['knowledge:approved-cultivation']};
  await execute('policy.set',{policy},'human');
  const design=draft();design.permissions.dataScopes=policy.dataScopes;
  const submitted=await execute('design.submit',{design});
  const registered=await execute('agent.register',{designId:submitted.result.id}),agentId=registered.result.id;
  const job=await knowledge.store.offerCultivation({id:randomUUID(),sessionId:`cultivation:${agentId}`,
    status:'completed',request:{origin:'cultivation'},cultivation:{workspace:f.storage.workspace,agentId,
      designId:submitted.result.id,output:'网络配置假设'}});
  const decision={jobId:job.id,scope:'mother',decision:'adopt',reason:'Independent source checked'};
  await assert.rejects(execute('learning.decide',decision,'mother',job.revision),/independent_evidence_required/);
  fs.mkdirSync(path.join(f.root,'docs'));fs.writeFileSync(path.join(f.root,'docs/network.txt'),'网络配置：修改后核对连接状态。');
  await knowledge.updatePolicy({allowedRoots:['docs']},1);
  const correction=await knowledge.supplement(job.id,{kind:'file',path:'docs/network.txt'},job.revision,2);
  await knowledge.worker.tick();const review=await knowledge.store.get(correction.id);
  await knowledge.review(correction.id,{decision:'accept_source',confirmed:true,note:'Test independent document'},review.revision,2);
  await knowledge.worker.tick();const resolved=await knowledge.store.get(job.id);
  const adopted=await execute('learning.decide',decision,'mother',resolved.revision);
  const input={executionIdentity:f.source,query:'网络配置',sessionId:f.run.sessionId,runId:f.run.id};
  const context=()=>cultivationChatContext(runtime,knowledge,input);
  const text=await context(),entryId=adopted.resolution.entryId;
  assert.ok(text.includes(`[知识:${entryId}]`));assert.ok(!text.includes('网络配置假设'));
  assert.deepEqual(runStore.get(f.run.id).cultivationReferences.ids,[entryId]);
  const usage=path.join(f.root,`记忆/知识/usage/${entryId}.json`);assert.equal(fs.existsSync(usage),false);
  await execute('policy.set',{policy:{...policy,motherLearning:false}},'human');
  assert.equal(await context(),'');assert.deepEqual(runStore.get(f.run.id).cultivationReferences.ids,[]);
  await execute('policy.set',{policy},'human');
  assert.equal(await context(),'','restoring the flag cannot resurrect an old autonomous adoption');
  const renewed=await execute('learning.decide',decision,'mother',adopted.revision);
  assert.ok(await context());
  clock=Date.parse(policy.expiresAt);
  assert.equal(await context(),'','expired policy cannot be used');
  clock=Date.now();assert.ok(await context());
  await execute('policy.set',{policy:{...policy,motherLearning:false}},'human');
  await execute('learning.decide',decision,'human',renewed.revision);
  assert.ok(await context(),'an explicit human adoption remains separate from the autonomous flag');
  fs.appendFileSync(path.join(f.root,`events/${f.run.id}.jsonl`),JSON.stringify({runId:f.run.id,sessionId:f.run.sessionId,
    seq:f.manager.readAfter(f.run.id,0).length+1,type:'delta',data:{text:`按资料核对。[知识:${entryId}]`}})+'\n');
  runStore.update(f.run.id,{status:'completed'});await knowledge.onRunFinished(f.run);
  assert.equal((await knowledge.status()).lastError,null);
  assert.equal(JSON.parse(fs.readFileSync(usage)).count,1);
  assert.equal((await knowledge.store.get(job.id)).provenance.userAcceptance,null);
});
