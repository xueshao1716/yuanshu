import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
const module = await import('../../engine/knowledge-runtime.mjs').catch(()=>({}));
function fixture(t,options={}){
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-runtime-'));
  t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));initFileLock({dir:path.join(wsRoot,'locks')});
  const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});
  fs.mkdirSync(path.join(wsRoot,'docs'));fs.writeFileSync(path.join(wsRoot,'docs/network.txt'),'网络配置：修改以后需要核对连接状态。');
  assert.equal(typeof module.createKnowledgeRuntime,'function');
  const runtime=module.createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog:()=>[],directChat:()=>assert.fail('no external calls'),...options});
  t.after(()=>runtime.close());return {wsRoot,runRoot,runStore,runtime};
}
test('runtime completes local source -> retrieval -> actual citation feedback, never counts retrieval alone',async t=>{
 const {runtime:r,wsRoot,runRoot,runStore}=fixture(t);
 await r.updatePolicy({allowedRoots:['docs']},1);
 const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);
 await r.worker.tick();assert.equal((await r.store.get(job.id)).state,'committed');
 const run=runStore.create({sessionId:'s',clientRequestId:'r',message:'网络配置',backgroundRecovery:{scope:wsRoot}});
 const result=await r.context({query:'网络配置',sessionId:'s',runId:run.id});
 assert.equal(result.entries.length,1);const id=result.entries[0].id;assert.ok(result.context.includes(`[知识:${id}]`));
 const usage=path.join(wsRoot,`记忆/知识/usage/${id}.json`);assert.equal(fs.existsSync(usage),false);
 fs.mkdirSync(path.join(runRoot,'events'));fs.writeFileSync(path.join(runRoot,`events/${run.id}.jsonl`),JSON.stringify({runId:run.id,sessionId:'s',seq:1,type:'delta',data:{text:`按资料核对连接。[知识:${id}]`}})+'\n');
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);await r.onRunFinished(run);
 assert.equal(JSON.parse(fs.readFileSync(usage)).count,1);
 await r.updatePolicy({allowedRoots:[]},2);assert.equal((await r.context({query:'网络配置',sessionId:'s',runId:'other'})).entries.length,0);
});
test('policy and enqueue are revisioned; unauthorized sources and non-text models fail before any calls',async t=>{
 const {runtime:r}=fixture(t,{catalog:()=>[{provider:'p',id:'image',enabled:true,capabilities:['image']}]});
 await assert.rejects(r.enqueue({kind:'file',path:'docs/network.txt'},1),{code:'source_not_authorized'});
 await assert.rejects(r.updatePolicy({model:'p/image',allowedModels:['p/image']},1),{code:'model_not_authorized'});
 await assert.rejects(r.enqueue({kind:'file',path:'docs/network.txt'},0),{code:'revision_conflict'});
 assert.equal((await r.store.list()).total,0);
});
test('status is read-only; startup delay is not bypassed by a wake or busy foreground',async t=>{
 let busy=true;const {runtime:r}=fixture(t,{foregroundBusy:()=>busy});
 assert.equal((await r.status()).summary.total,0);
 await r.updatePolicy({allowedRoots:['docs']},1);const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);
 assert.equal((await r.worker.tick()).state,'foreground_busy');
 r.start({startupMs:10000,intervalMs:10000});r.worker.wake();busy=false;
 await new Promise(resolve=>setTimeout(resolve,1100));
 assert.equal((await r.store.get(job.id)).state,'queued');
});
test('URL intake is offline; only worker fetches approved source and retrieval never fetches',async t=>{
 let calls=0;
 const {runtime:r}=fixture(t,{network:{lookup:async()=>[{address:'8.8.8.8',family:4}],transport:async()=>{
  calls++;return {status:200,headers:{'content-type':'text/plain'},body:Buffer.from('网络资料：连接需要核对。')};
 }}});
 await r.updatePolicy({networkEnabled:true,allowedUrls:['https://example.org/network']},1);
 const job=await r.enqueue({kind:'url',url:'https://example.org/network'},2);assert.equal(calls,0);
 await r.worker.tick();assert.equal((await r.store.get(job.id)).state,'committed');assert.equal(calls,2);
 assert.equal((await r.context({query:'网络资料',sessionId:'s'})).entries.length,1);assert.equal(calls,2);
 await r.updatePolicy({networkEnabled:false},2);
 assert.equal((await r.context({query:'网络资料',sessionId:'s'})).entries.length,0);
});
test('policy changes revive only permission-blocked tasks, not review or paused tasks',async t=>{
 const {runtime:r}=fixture(t);
 await r.updatePolicy({allowedRoots:['docs']},1);
 const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);
 await r.store.block(job.id,'source_not_authorized');
 await r.updatePolicy({allowedRoots:['docs','notes']},2);
 assert.equal((await r.store.get(job.id)).state,'queued');
 const paused=await r.control(job.id,'pause',(await r.store.get(job.id)).revision);
 await r.updatePolicy({allowedRoots:['docs']},3);
 assert.equal((await r.store.get(paused.id)).state,'paused');
});
test('unrelated settings do not wake exhausted budget tasks',async t=>{
 const {runtime:r}=fixture(t);await r.updatePolicy({allowedRoots:['docs']},1);
 const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);await r.store.block(job.id,'budget_exhausted');
 await r.updatePolicy({allowedUrls:['https://example.org/network']},2);
 assert.equal((await r.store.get(job.id)).state,'blocked');
});
test('UTC budget rollover wakes budget blocks but not manually paused work',async t=>{
 let clock=Date.parse('2026-09-30T12:00:00Z');const {runtime:r}=fixture(t,{now:()=>clock});
 await r.updatePolicy({allowedRoots:['docs']},1);
 const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);await r.store.block(job.id,'budget_exhausted');
 await r.worker.tick();assert.equal((await r.store.get(job.id)).state,'blocked');
 clock+=86400000;await r.worker.tick();assert.equal((await r.store.get(job.id)).state,'committed');
});
test('changed and expired source versions are renewed automatically without returning old text',async t=>{
 let clock=Date.parse('2026-09-30T12:00:00Z');const {runtime:r,wsRoot}=fixture(t,{now:()=>clock});
 await r.updatePolicy({allowedRoots:['docs']},1);const original=await r.enqueue({kind:'file',path:'docs/network.txt'},2);
 await r.worker.tick();fs.writeFileSync(path.join(wsRoot,'docs/network.txt'),'网络配置：以修订后的连接说明为准。');
 assert.equal((await r.context({query:'网络配置',sessionId:'s'})).entries.length,0);
 await r.worker.tick();const fresh=await r.context({query:'网络配置',sessionId:'s'});
 assert.equal(fresh.entries.length,1);assert.ok(fresh.context.includes('修订后的'));assert.notEqual(fresh.entries[0].jobId,original.id);
 clock+=31*86400000;assert.equal((await r.context({query:'网络配置',sessionId:'s'})).entries.length,0);
 await r.worker.tick();assert.equal((await r.context({query:'网络配置',sessionId:'s'})).entries.length,1);
});

test('a real scoped retrieval gap automatically processes an explicitly attached authorized source',async t=>{
 const {runtime:r,wsRoot,runStore}=fixture(t);
 await r.retrieval.refresh();
 const run=runStore.create({sessionId:'gap-session',clientRequestId:'gap',message:'网络配置',files:[{path:'docs/network.txt'}],backgroundRecovery:{scope:wsRoot}});
 await r.context({query:'网络配置',sessionId:run.sessionId,runId:run.id});
 assert.equal((await r.store.list()).total,0,'no extraction within chat');
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);
 await r.worker.tick();await r.worker.tick();
 const jobs=(await r.store.list()).items;
 assert.ok(jobs.some(j=>j.event==='gap'&&j.state==='committed'));
 assert.ok((await r.context({query:'网络配置',sessionId:run.sessionId})).context.includes('修改以后需要核对连接状态'));
});

test('conflicting exact key-value sources quarantine both versions, correction preserves review links',async t=>{
 const {runtime:r,wsRoot}=fixture(t);await r.updatePolicy({allowedRoots:['docs']},1);
 fs.writeFileSync(path.join(wsRoot,'docs/first.txt'),'服务端口：8787');
 fs.writeFileSync(path.join(wsRoot,'docs/second.txt'),'服务端口：9900');
 const first=await r.enqueue({kind:'file',path:'docs/first.txt'},2);await r.worker.tick();
 const second=await r.enqueue({kind:'file',path:'docs/second.txt'},2);await r.worker.tick();
 const review=await r.store.get(second.id);assert.equal(review.state,'review_required');
 assert.equal((await r.store.entries())[0].status,'conflict');
 assert.equal((await r.context({query:'服务端口',sessionId:'s'})).entries.length,0);
 fs.writeFileSync(path.join(wsRoot,'docs/second.txt'),'服务端口：8787');
 const fix=await r.supplement(second.id,{kind:'file',path:'docs/second.txt'},review.revision,2);
 assert.equal(fix.event,'correction');assert.equal(fix.relatedJobId,second.id);
 await r.worker.tick();assert.equal((await r.store.get(fix.id)).state,'review_required','correction is not an automatic approval');
 assert.equal((await r.store.get(first.id)).state,'committed','immutable original evidence is retained');
});

test('gap extraction from a shared authorized root remains bound to its originating session',async t=>{
 const {runtime:r,wsRoot,runStore}=fixture(t);await r.updatePolicy({allowedRoots:['docs']},1);
 const run=runStore.create({sessionId:'private-gap',clientRequestId:'shared-root',message:'网络配置',backgroundRecovery:{scope:wsRoot}});
 await r.context({query:'网络配置',sessionId:run.sessionId,runId:run.id});
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);await r.worker.tick();await r.worker.tick();
 assert.ok((await r.context({query:'网络配置',sessionId:run.sessionId})).entries.length);
 assert.equal((await r.context({query:'网络配置',sessionId:'unrelated'})).entries.length,0);
});

test('disabled text models are not selectable or authorizable',async t=>{
 const {runtime:r}=fixture(t,{catalog:()=>[{provider:'p',id:'text',enabled:false,capabilities:['text']}]});
 assert.deepEqual(await r.models(),[]);
 await assert.rejects(r.updatePolicy({model:'p/text',allowedModels:['p/text']},1),{code:'model_not_authorized'});
});
test('saving an unchanged full policy does not wake budget or permission blocks',async t=>{
 const {runtime:r}=fixture(t);await r.updatePolicy({allowedRoots:['docs']},1);
 const job=await r.enqueue({kind:'file',path:'docs/network.txt'},2);await r.store.block(job.id,'budget_exhausted');
 const {revision,concurrency,...patch}=await r.store.policy();await r.updatePolicy(patch,revision);
 assert.equal((await r.store.get(job.id)).state,'blocked');
});
test('maintenance compares only the stored source subset rather than the entire original run',async t=>{
 const {runtime:r,wsRoot,runRoot,runStore}=fixture(t);
 const run=runStore.create({sessionId:'subset',clientRequestId:'subset',message:'网络配置',backgroundRecovery:{scope:wsRoot}});
 fs.mkdirSync(path.join(runRoot,'events'));
 fs.writeFileSync(path.join(runRoot,`events/${run.id}.jsonl`),JSON.stringify({runId:run.id,sessionId:run.sessionId,seq:1,type:'delta',data:{text:'网络配置：实际输出记录'}})+'\n');
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);await r.worker.tick();
 const before=await r.store.list();assert.equal(before.total,1);
 await r.worker.tick();assert.equal((await r.store.list()).total,1,'unchanged output must not create a review');
 assert.equal((await r.store.entries())[0].status,'active');
});
test('a gap waiting for sources resumes discovery after authorization without new user chat',async t=>{
 const {runtime:r,wsRoot,runStore}=fixture(t);await r.retrieval.refresh();
 const run=runStore.create({sessionId:'later',clientRequestId:'later',message:'网络配置',backgroundRecovery:{scope:wsRoot}});
 await r.context({query:'网络配置',sessionId:run.sessionId,runId:run.id});
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);await r.worker.tick();
 assert.ok((await r.store.list()).items.some(j=>j.event==='gap'&&j.reason==='source_missing'));
 await r.updatePolicy({allowedRoots:['docs']},1);await r.worker.tick();await r.worker.tick();await r.worker.tick();
 assert.ok((await r.store.list()).items.some(j=>j.event==='gap'&&j.state==='committed'));
 const prior=(await r.store.list()).items.find(j=>j.event==='gap'&&!j.sources.length);
 assert.equal(prior.state,'skipped');assert.equal(prior.reason,'source_replaced');
 assert.equal((await r.store.get(prior.replacementJobId)).sessionId,run.sessionId);
});

test('aibody projection is scoped and contains stages but no source contents or growth claims',async t=>{
 const {runtime:r,wsRoot,runStore}=fixture(t);
 const run=runStore.create({sessionId:'private',clientRequestId:'projection',message:'private body',backgroundRecovery:{scope:wsRoot}});
 runStore.update(run.id,{status:'completed'});await r.onRunFinished(run);
 assert.equal(typeof r.projection,'function');
 const result=await r.projection({sessionId:'private',runId:run.id});
 assert.equal(result.jobs.length,1);assert.ok(result.jobs[0].id);assert.ok(result.jobs[0].stage);
 assert.ok(!JSON.stringify(result).includes('private body'));assert.equal(result.methodVerified,false);
 assert.deepEqual((await r.projection({sessionId:'foreign',runId:run.id})).jobs,[]);
});
