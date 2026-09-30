import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createKnowledgeRuntime} from '../../engine/knowledge-runtime.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {guardFor,digest} from '../../engine/knowledge-state.mjs';
const decision={decision:'accept_source',note:'核对真实来源后采用补证',confirmed:true};
async function setup(t,blocked=false){
 const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-resolution-'));
 t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));initFileLock({dir:path.join(wsRoot,'locks')});
 const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});fs.mkdirSync(path.join(wsRoot,'docs'));
 for(const [name,text] of [['a','服务端口：8787'],['b','服务端口：9900'],['c','服务端口：8800'],['d','服务端口：8811']])
  fs.writeFileSync(path.join(wsRoot,'docs',name+'.txt'),text);
 const r=createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog:()=>[],directChat:()=>assert.fail('no provider')});t.after(()=>r.close());
 await r.updatePolicy({allowedRoots:['docs']},1);
 await r.enqueue({kind:'file',path:'docs/a.txt'},2,{sessionId:'s'});await r.worker.tick();
 const b=blocked==='gap'?await r.store.enqueue({sourceId:'gap:r',sourceVersion:digest('missing'),event:'gap',runId:'r',sessionId:'s',sources:[]})
  :await r.enqueue({kind:'file',path:'docs/b.txt'},2,{sessionId:'s'});
 if(blocked)await r.store.block(b.id,blocked==='gap'?'source_missing':'source_not_authorized');else await r.worker.tick();
 const original=await r.store.get(b.id);
 const c=await r.supplement(b.id,{kind:'file',path:'docs/c.txt'},original.revision,2);await r.worker.tick();
 const correction=await r.store.get(c.id);await r.review(c.id,decision,correction.revision,2);
 return {wsRoot,runRoot,runStore,r,original,correction};
}
test('resolved original is projected separately from pending without rewriting audit and survives reopening',async t=>{
 const {r,original,correction,wsRoot}=await setup(t);await r.worker.tick();
 const saved=await r.store.get(original.id),resolvedBy=await r.store.get(correction.id);
 assert.equal(saved.state,'review_required');assert.equal(saved.displayState,'resolved');
 assert.deepEqual(saved.validation,original.validation);assert.deepEqual(saved.candidate,original.candidate);
 assert.deepEqual(saved.reviews,original.reviews);assert.equal(saved.reason,original.reason);
 assert.equal(saved.resolution.jobId,correction.id);assert.equal(saved.resolution.entryId,resolvedBy.entryId);
 assert.equal((await r.store.summary()).counts.review_required||0,0);assert.equal((await r.store.summary()).counts.resolved,1);
 assert.equal((await r.store.list()).items.find(j=>j.id===original.id).displayState,'resolved');
 assert.equal((await r.detail(original.id)).displayState,'resolved');assert.equal((await r.projection()).counts.resolved,1);
 const projected=(await r.projection({sessionId:'s'})).jobs.find(j=>j.id===original.id);
 assert.equal(projected.displayState,'resolved');assert.deepEqual(projected.resolution,saved.resolution);
 const reopened=createKnowledgeStore({wsRoot});await reopened.recover();
 assert.deepEqual(await reopened.get(original.id),saved);assert.equal((await reopened.summary()).counts.resolved,1);
});
test('resolved originals reject new review, control and supplement without changing history',async t=>{
 const {r,original,correction}=await setup(t);await r.worker.tick();const saved=await r.store.get(original.id);
 for(const choice of ['accept_source','keep_existing','reject'])
  await assert.rejects(r.review(saved.id,{...decision,decision:choice},saved.revision,2),{code:'job_resolved'});
 await assert.rejects(r.store.review(saved.id,decision,saved.revision,2),{code:'job_resolved'});
 await assert.rejects(r.control(saved.id,'cancel',saved.revision),{code:'job_resolved'});
 // Must stop before opening even a missing or unauthorized replacement source.
 await assert.rejects(r.supplement(saved.id,{kind:'file',path:'missing.txt'},saved.revision,2),{code:'job_resolved'});
 const child=await r.store.get(correction.id);
 await assert.rejects(r.store.enqueue({...child,sourceId:'another',event:'correction',relatedJobId:saved.id,
  expectedJobRevision:saved.revision,expectedPolicyRevision:2}),{code:'job_resolved'});
 assert.deepEqual(await r.store.get(saved.id),saved);
});
test('a pending sibling cannot adjudicate an already resolved original',async t=>{
 const {r,original}=await setup(t);
 const sibling=await r.supplement(original.id,{kind:'file',path:'docs/d.txt'},original.revision,2);
 await r.worker.tick();await r.worker.tick();const current=await r.store.get(sibling.id);
 assert.equal(current.state,'review_required');
 await assert.rejects(r.review(current.id,decision,current.revision,2),{code:'job_resolved'});
 assert.equal((await r.store.summary()).counts.resolved,1);
});
test('resolution is recovered atomically with supplementary entry and retains review evidence',async t=>{
 const {r,wsRoot,runRoot,runStore,original,correction}=await setup(t);
 const crashStore=createKnowledgeStore({wsRoot,runRoot,runStore,fault:stage=>{if(stage==='afterEntry')throw Error('crash');}});
 let job=await crashStore.claim('recovery-owner');assert.equal(job.id,correction.id);
 const approvedAudit=job.reviews;
 const snapshots=job.candidate;assert.ok(snapshots.sourceHash);
 // The fixed test fixture uses the exact already-reviewed candidate as its entry.
 const entry={kind:'source',text:job.candidate.text,sourceVersion:job.sourceVersion,verified:false,status:'active',
  sources:[{hash:job.candidate.sourceHash,locator:'docs/c.txt',reference:{kind:'file',path:'docs/c.txt'}}]};
 job=await crashStore.transition(job.id,guardFor(job),{state:'ready',validation:{state:'ready',entry}});
 await assert.rejects(crashStore.commit(job.id,guardFor(job),entry),/crash/);
 assert.equal((await r.store.get(original.id)).resolution,undefined);
 const recovered=createKnowledgeStore({wsRoot,runRoot,runStore});await recovered.recover();await recovered.recover();
 const parent=await recovered.get(original.id),child=await recovered.get(correction.id);
 assert.equal(parent.displayState,'resolved');assert.equal(parent.resolution.entryId,child.entryId);
 assert.deepEqual(child.reviews,approvedAudit);assert.deepEqual(parent.validation,original.validation);
 assert.equal((await recovered.summary()).counts.resolved,1);assert.equal((await recovered.entries()).length,2);
});
test('revoked sources remain excluded while historical resolution and original audit persist',async t=>{
 const {r,original}=await setup(t);await r.worker.tick();const before=await r.store.get(original.id);
 assert.equal((await r.context({query:'服务端口',sessionId:'s'})).entries.length,1);
 await r.updatePolicy({allowedRoots:[]},2);
 assert.equal((await r.context({query:'服务端口',sessionId:'s'})).entries.length,0);
 const after=await r.detail(original.id);assert.equal(after.displayState,'resolved');
 assert.deepEqual(after.resolution,before.resolution);assert.deepEqual(after.validation,original.validation);
 assert.equal((await r.store.summary()).counts.review_required||0,0);
});

test('resolved blocked originals stay historical when policy wake conditions recur',async t=>{
 const {r,original}=await setup(t,true);await r.worker.tick();const saved=await r.store.get(original.id);
 assert.equal(saved.state,'blocked');assert.ok(saved.resolution);
 assert.equal(await r.store.wakeBlocked(['source_not_authorized']),0);
 assert.deepEqual(await r.store.get(original.id),saved);
 assert.equal(await r.store.claim('must-not-resume'),null);
 assert.equal((await r.store.summary()).counts.blocked||0,0);
});

test('automatic gap replacement does not rewrite an already resolved missing-source audit',async t=>{
 const {r,original}=await setup(t,'gap');await r.worker.tick();const saved=await r.store.get(original.id);
 assert.equal(saved.state,'blocked');assert.equal(saved.reason,'source_missing');assert.ok(saved.resolution);
 const replacement=await r.store.enqueue({sourceId:'gap:replacement',sourceVersion:digest('replacement'),event:'gap',runId:'r',sessionId:'s',sources:[{kind:'file',path:'docs/d.txt'}]});
 await r.store.supersedeMissingGap('r','s',replacement.id);
 assert.deepEqual(await r.store.get(original.id),saved);
});
