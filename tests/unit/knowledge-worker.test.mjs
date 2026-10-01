import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeWorker} from '../../engine/knowledge-worker.mjs';
import {collectLocalSources} from '../../engine/knowledge-sources.mjs';
import {extractLocal,validateCandidate} from '../../engine/knowledge-evidence.mjs';
import {digest} from '../../engine/knowledge-state.mjs';
async function fixture(t,options={}){
 const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-worker-'));t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));initFileLock({dir:path.join(wsRoot,'locks')});
 fs.mkdirSync(path.join(wsRoot,'docs'));fs.writeFileSync(path.join(wsRoot,'docs/source.txt'),'示例知识：出处可追溯。');
 let clock=1800000000000,busy=false;const now=()=>clock,store=createKnowledgeStore({wsRoot,now});
 const policy=await store.updatePolicy({allowedRoots:['docs']},1),sources=[{kind:'file',path:'docs/source.txt'}];
 const collect=({job,policy})=>collectLocalSources({wsRoot,sources:job.sources,policy});
 const snapshots=await collect({job:{sources},policy});
 const job=await store.enqueue({sourceId:'docs/source.txt',sourceVersion:digest(snapshots.map(s=>[s.locator,s.hash])),event:'manual',sources});
 const worker=createKnowledgeWorker({store,collect,extract:extractLocal,validate:validateCandidate,foregroundBusy:()=>busy,now,random:()=>0,...options});
 t.after(()=>worker.stop());return {wsRoot,store,worker,job,setBusy:v=>busy=v,advance:ms=>clock+=ms};
}
test('knowledge worker honors shared admission before collecting and releases its slot',async t=>{
 let permitted=false,released=0;
 const admission={acquire:async()=>permitted?{id:'slot'}:null,release:async id=>{assert.equal(id,'slot');released++;}};
 const f=await fixture(t,{admission});
 assert.equal((await f.worker.tick()).state,'background_busy');
 assert.equal((await f.store.get(f.job.id)).state,'queued');
 permitted=true;await f.worker.tick();
 assert.equal((await f.store.get(f.job.id)).state,'committed');assert.equal(released,1);
});
test('shared slot remains held through cancellation until asynchronous work ends',async t=>{
 let entered,finish,released=0;const started=new Promise(r=>entered=r),done=new Promise(r=>finish=r);
 const f=await fixture(t,{admission:{acquire:async()=>({id:'slot'}),release:async()=>{released++;}},
   extract:async()=>{entered();await done;throw Object.assign(new Error('aborted'),{name:'AbortError'});}});
 const tick=f.worker.tick();await started;const stopped=f.worker.stop();
 await new Promise(r=>setImmediate(r));assert.equal(released,0);finish();
 await Promise.all([tick,stopped]);assert.equal(released,1);
 assert.equal((await f.store.get(f.job.id)).state,'retry_wait');
});
test('worker drives a source to exactly one committed entry and yields to foreground',async t=>{
 const f=await fixture(t);f.setBusy(true);assert.equal((await f.worker.tick()).state,'foreground_busy');assert.equal((await f.store.get(f.job.id)).state,'queued');
 f.setBusy(false);await f.worker.tick();assert.equal((await f.store.get(f.job.id)).state,'committed');
 await f.worker.tick();assert.equal((await f.store.entries()).length,1);
});
test('changed source cannot commit an older candidate',async t=>{
 let root;const f=await fixture(t,{extract:(snapshots,job)=>{fs.writeFileSync(path.join(root,'docs/source.txt'),'改变后的正文');return extractLocal(snapshots,job);}});root=f.wsRoot;
 await f.worker.tick();assert.equal((await f.store.get(f.job.id)).state,'blocked');assert.equal((await f.store.get(f.job.id)).reason,'source_changed');assert.equal((await f.store.entries()).length,0);
});
test('foreground yield preserves completed extraction and resumes without another provider call',async t=>{
 let calls=0,f;f=await fixture(t,{extract:(snapshots,job)=>{calls++;f.setBusy(true);return extractLocal(snapshots,job);}});
 assert.equal((await f.worker.tick()).reason,'foreground_busy');
 const waiting=await f.store.get(f.job.id);assert.equal(waiting.state,'retry_wait');assert.equal(waiting.stage,'validating');
 assert.equal(waiting.candidate.text,'示例知识：出处可追溯。');assert.equal((await f.store.entries()).length,0);
 f.setBusy(false);f.advance(1000);await f.worker.tick();
 assert.equal((await f.store.get(f.job.id)).state,'committed');assert.equal(calls,1);
});
test('foreground yield never saves an extraction after authorization changes',async t=>{
 let f;f=await fixture(t,{extract:async(snapshots,job)=>{
   f.setBusy(true);await f.store.updatePolicy({allowedRoots:[]},2);return extractLocal(snapshots,job);
 }});
 await f.worker.tick();const job=await f.store.get(f.job.id);
 assert.equal(job.candidate,undefined);assert.equal((await f.store.entries()).length,0);
});
test('transient failures retry at one and five minutes then stop; auth never retries',async t=>{
 const f=await fixture(t,{extract:()=>{throw Object.assign(Error('private details'),{code:'provider_transient'});}});
 await f.worker.tick();let j=await f.store.get(f.job.id);assert.equal(j.state,'retry_wait');assert.equal(j.attempts,1);
 await f.worker.tick();assert.equal((await f.store.get(j.id)).attempts,1);f.advance(60000);await f.worker.tick();
 j=await f.store.get(j.id);assert.equal(j.attempts,2);f.advance(300000);await f.worker.tick();assert.equal((await f.store.get(j.id)).state,'failed');
 const other=await fixture(t,{extract:()=>{throw Object.assign(Error('secret'),{code:'provider_auth'});}});await other.worker.tick();
 assert.equal((await other.store.get(other.job.id)).state,'blocked');assert.equal((await other.store.get(other.job.id)).reason,'provider_auth');
});
test('cancelling while extracting aborts work and cannot resurrect task',async t=>{
 let entered,release;const started=new Promise(r=>entered=r);
 const f=await fixture(t,{extract:async(_snapshots,_job,{signal})=>{entered();await new Promise(r=>{release=r;signal.addEventListener('abort',r,{once:true});});return {kind:'source',text:'late'};}});
 const work=f.worker.tick();await started;const current=await f.store.get(f.job.id);await f.store.control(current.id,'cancel',current.revision);f.worker.interrupt();release();await work;
 assert.equal((await f.store.get(current.id)).state,'cancelled');assert.equal((await f.store.entries()).length,0);
});

test('stop aborts maintenance and waits for its cleanup before returning',async t=>{
 let enter,exit,cleaned=false;
 const entered=new Promise(r=>enter=r),release=new Promise(r=>exit=r);
 const f=await fixture(t,{reconcile:async({signal}={})=>{enter(signal);await release;cleaned=true;signal?.throwIfAborted();}});
 const tick=f.worker.tick();const signal=await entered;
 let closed=false;const close=Promise.resolve(f.worker.stop()).then(()=>{closed=true;});
 await new Promise(r=>setImmediate(r));
 const premature=closed;exit();await Promise.all([tick,close]);
 assert.equal(premature,false);assert.equal(signal?.aborted,true);assert.equal(cleaned,true);
 assert.equal((await f.store.get(f.job.id)).state,'queued');
});

test('upstream circuit cooldown survives worker recreation',async t=>{
 const f=await fixture(t,{extract:()=>{throw Object.assign(Error('transient'),{code:'provider_transient'});}});
 await f.worker.tick();f.advance(60000);await f.worker.tick();f.advance(300000);await f.worker.tick();
 await f.worker.stop();
 const replacement=createKnowledgeWorker({store:f.store,collect:()=>assert.fail('cooldown must prevent work'),now:()=>1800000360000});
 t.after(()=>replacement.stop());
 assert.equal((await replacement.tick()).state,'cooldown');
});
