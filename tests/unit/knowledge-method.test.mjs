import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createKnowledgeRuntime} from '../../engine/knowledge-runtime.mjs';
import {validateCandidate} from '../../engine/knowledge-evidence.mjs';
function fixture(t){
 const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-method-'));
 t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));initFileLock({dir:path.join(wsRoot,'locks')});
 const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});
 for(const dir of ['docs','生成物'])fs.mkdirSync(path.join(wsRoot,dir));
 const write=(name,value)=>fs.writeFileSync(path.join(wsRoot,name),typeof value==='string'?value:JSON.stringify(value));
 write('docs/method.txt','网络配置生成方法：按契约生成端口和服务名称。');
 write('生成物/result.json',{port:8787,service:'yuanshu'});
 const run=runStore.create({sessionId:'method-session',clientRequestId:'method',message:'生成网络配置',backgroundRecovery:{scope:wsRoot}});
 runStore.update(run.id,{status:'completed'});fs.mkdirSync(path.join(runRoot,'events'));
 write(`ledger/events/${run.id}.jsonl`,JSON.stringify({runId:run.id,sessionId:run.sessionId,seq:1,type:'artifact_created',data:{path:'生成物/result.json'}})+'\n');
 const manifest={version:1,checker:'json-contract-v1',sourcePath:'docs/method.txt',offset:0,length:26,artifactPath:'生成物/result.json',
  assertions:[{pointer:'/port',equals:8787},{pointer:'/service',equals:'yuanshu'}]};
 manifest.length=fs.readFileSync(path.join(wsRoot,'docs/method.txt'),'utf8').length;write('docs/contract.json',manifest);
 const r=createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog:()=>[],directChat:()=>assert.fail('no provider')});t.after(()=>r.close());
 return {r,wsRoot,run,runStore,write,manifest,source:{kind:'method',path:'docs/contract.json',runId:run.id,sessionId:run.sessionId}};
}
test('explicit method checks actual run artifact with bounded JSON contract and scoped evidence',async t=>{
 const {r,run,source}=fixture(t);await r.updatePolicy({allowedRoots:['docs','生成物']},1);
 const job=await r.enqueue(source,2);await r.worker.tick();const current=await r.store.get(job.id);
 assert.equal(current.state,'committed');const entry=(await r.store.entries()).find(e=>e.jobId===job.id);
 assert.equal(entry.kind,'method');assert.equal(entry.verified,true);assert.equal(entry.method.checker,'json-contract-v1');
 assert.equal(entry.method.environment.sessionId,run.sessionId);assert.equal(entry.method.environment.runId,run.id);
 assert.ok(entry.scope.includes('不证明'));assert.ok(entry.method.artifactHash);assert.ok(entry.method.runDigest);
 assert.equal((await r.context({query:'网络配置生成方法',sessionId:run.sessionId})).entries.length,1);
 assert.equal((await r.context({query:'网络配置生成方法',sessionId:'foreign'})).entries.length,0);
});
test('failed contract stays unverified despite a model PASS or mere file existence',async t=>{
 const {r,source,write,manifest}=fixture(t);write('生成物/result.json',{port:9900,service:'yuanshu',result:'PASS'});
 await r.updatePolicy({allowedRoots:['docs','生成物']},1);const job=await r.enqueue(source,2);await r.worker.tick();
 assert.equal((await r.store.get(job.id)).state,'review_required');assert.equal((await r.store.get(job.id)).reason,'method_check_failed');
 assert.equal((await r.store.entries()).length,0);
 const pending=await r.store.get(job.id);await assert.rejects(r.review(job.id,{decision:'accept_source',note:'PASS',confirmed:true},pending.revision,2),{code:'review_not_eligible'});
 assert.equal(validateCandidate({candidate:{kind:'method',text:'PASS',verified:true,methodProof:{pass:true}},snapshots:[],job:{}}).state,'review_required');
});
test('method cannot bind an artifact outside the actual completed run or execute manifest commands',async t=>{
 const {r,source,write,manifest}=fixture(t);write('生成物/other.json',{port:8787,service:'yuanshu'});manifest.artifactPath='生成物/other.json';
 write('docs/contract.json',manifest);await r.updatePolicy({allowedRoots:['docs','生成物']},1);
 const job=await r.enqueue(source,2);await r.worker.tick();assert.equal((await r.store.get(job.id)).reason,'method_artifact_unbound');
 manifest.checker='shell';manifest.command='write secret';write('docs/contract.json',manifest);
 await assert.rejects(r.enqueue(source,2),{code:'method_manifest_invalid'});
});
test('changed artifact or revoked source authorization immediately removes method retrieval',async t=>{
 const {r,source,run,write}=fixture(t);await r.updatePolicy({allowedRoots:['docs','生成物']},1);
 const job=await r.enqueue(source,2);await r.worker.tick();assert.equal((await r.store.get(job.id)).state,'committed');
 write('生成物/result.json',{port:9900,service:'yuanshu'});
 assert.equal((await r.context({query:'网络配置',sessionId:run.sessionId})).entries.length,0);
 await r.updatePolicy({allowedRoots:['docs']},2);
 assert.equal((await r.context({query:'网络配置',sessionId:run.sessionId})).entries.length,0);
});
