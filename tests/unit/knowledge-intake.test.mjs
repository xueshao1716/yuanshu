import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
const module = await import('../../engine/knowledge-intake.mjs').catch(()=>({}));
function fixture(t){
 const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-intake-'));t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
 initFileLock({dir:path.join(wsRoot,'locks')});const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});
 const store=createKnowledgeStore({wsRoot});assert.equal(typeof module.createKnowledgeIntake,'function');
 const intake=module.createKnowledgeIntake({wsRoot,runRoot,runStore,store});t.after(()=>intake.close());
 const run=(status='completed',extra={})=>{const r=runStore.create({sessionId:'s',clientRequestId:Math.random().toString(),message:'有完整正文的资料',backgroundRecovery:{scope:wsRoot},...extra});return runStore.update(r.id,{status});};
 return {wsRoot,runRoot,runStore,store,intake,run};
}
test('intake persists real completed and failed sources once and excludes its own generated work',async t=>{
 const f=fixture(t),r=f.run();await f.intake.enqueueRun(r);await f.intake.enqueueRun(r);
 await f.intake.enqueueRun(f.run('failed'));await f.intake.enqueueRun(f.run('completed',{origin:'knowledge'}));
 const jobs=await f.store.list();assert.equal(jobs.total,2);assert.ok(jobs.items.every(j=>j.sources[0].kind==='run'));
 assert.equal(jobs.items.find(j=>j.event==='failed').state,'queued');
});
test('migration backs up once, keeps missing-source tasks visibly blocked and is idempotent',async t=>{
 const f=fixture(t),r=f.run(),file=path.join(f.wsRoot,'记忆/运行时/待提炼任务.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 const original=JSON.stringify({v:1,retired:4,entries:[{runId:r.id,sessionId:'s',title:'not the source'},{runId:'missing',sessionId:'s',title:'never fabricate'}]});fs.writeFileSync(file,original);
 await f.intake.reconcile();await f.intake.reconcile();const jobs=await f.store.list();assert.equal(jobs.total,2);
 const missing=jobs.items.find(j=>j.runId==='missing');assert.equal(missing.state,'blocked');assert.equal(missing.reason,'source_missing');assert.ok(!JSON.stringify(missing).includes('never fabricate'));
 assert.equal(fs.readFileSync(path.join(f.wsRoot,'记忆/知识/legacy-intake-backup.json'),'utf8'),original);
 assert.equal(f.intake.status().legacyRetired,4);
});
test('reconciliation visits at most twenty ledger records per pass without dropping older pending',async t=>{
 const f=fixture(t);for(let i=0;i<27;i++)f.run();
 const first=await f.intake.reconcile();assert.ok(first.scanned<=20);assert.equal((await f.store.list()).total,20);
 await f.intake.reconcile();assert.equal((await f.store.list()).total,27);
});
test('concurrent migration acknowledgements cannot skip legacy records',async t=>{
 const f=fixture(t),file=path.join(f.wsRoot,'记忆/运行时/待提炼任务.json');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({v:1,entries:Array.from({length:45},(_,i)=>({runId:`missing${i}`,sessionId:'s'}))}));
 const second=module.createKnowledgeIntake({...f});t.after(()=>second.close());
 await Promise.all([f.intake.reconcile(),second.reconcile()]);
 for(let i=0;i<4;i++)await f.intake.reconcile();
 assert.equal((await f.store.list()).total,45);
});
