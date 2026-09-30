import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRunStore} from '../../engine/run-store.mjs';
import {createRunEventLog} from '../../engine/run-event-log.mjs';
import {createTaskEvidence} from '../../engine/task-evidence.mjs';
const mod=await import('../../engine/knowledge-provenance.mjs').catch(()=>({}));
function fixture(t){
 const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-provenance-'));
 t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
 const rootDir=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir}),log=createRunEventLog({rootDir});
 const run=runStore.create({sessionId:'s-one',clientRequestId:'r-one',message:'任务',backgroundRecovery:{scope:wsRoot}});
 runStore.update(run.id,{status:'completed'});
 log.append({runId:run.id,sessionId:run.sessionId,type:'delta',data:{text:'交付结果'}});
 const taskEvidence=createTaskEvidence({wsRoot,rootDir});
 assert.equal(typeof mod.createKnowledgeProvenance,'function');
 const read=mod.createKnowledgeProvenance({wsRoot,runStore,taskEvidence});
 return {wsRoot,runStore,run,taskEvidence,read,job:{runId:run.id,sessionId:run.sessionId,sources:[]}};
}
test('provenance separates task completion, objective checks and current human acceptance',t=>{
 const f=fixture(t);let result=f.read(f.job);
 assert.equal(result.task.status,'completed');assert.equal(result.task.acceptance,'pending');
 assert.equal(result.methodVerified,false);
 const evidence=f.taskEvidence.get(f.run.id);
 f.taskEvidence.review(f.run.id,{digest:evidence.digest,revision:null,verdict:'pass',skills:[],note:'人工检查'});
 result=f.read(f.job);assert.equal(result.task.acceptance,'pass');assert.equal(result.methodVerified,false);
 assert.ok(!JSON.stringify(result).includes('交付结果'));assert.ok(!JSON.stringify(result).includes('人工检查'));
 assert.equal(f.read({...f.job,sessionId:'foreign'}).status,'unavailable');
});
test('team model PASS and self-declared accepted delivery never substitute for actual approval',t=>{
 const f=fixture(t),teamId='team-one',base=`工程/多AI角色扮演系统/runs/${teamId}`;
 const record={runId:teamId,parentRunId:f.run.id,sessionId:f.run.sessionId,mode:'real',
  delivery:{status:'accepted'},checklist:{total:3,passed:3,failed:0}};
 fs.mkdirSync(path.join(f.wsRoot,base),{recursive:true});
 const file=path.join(f.wsRoot,base,'evolution-evidence.json');fs.writeFileSync(file,JSON.stringify(record));
 const job={...f.job,sources:[{kind:'file',path:`${base}/草稿/终稿.md`}]};
 const before=fs.readFileSync(file,'utf8'),result=f.read(job);
 assert.equal(result.teams.length,1);assert.equal(result.teams[0].modelReview,'PASS');
 assert.equal(result.teams[0].acceptance,'unknown');assert.equal(result.methodVerified,false);
 assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.writeFileSync(file,JSON.stringify({...record,sessionId:'foreign'}));
 assert.deepEqual(f.read(job).teams,[]);
});
test('unrelated or unscoped jobs cannot read task evidence',t=>{
 const f=fixture(t);
 assert.equal(f.read({...f.job,runId:null}).status,'not_applicable');
 f.runStore.update(f.run.id,{backgroundRecovery:{scope:path.join(f.wsRoot,'elsewhere')}});
 assert.equal(f.read(f.job).status,'unavailable');
 f.runStore.update(f.run.id,{backgroundRecovery:null});
 assert.equal(f.read(f.job).status,'unavailable');
});
