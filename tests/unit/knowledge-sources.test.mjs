import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectLocalSources} from '../../engine/knowledge-sources.mjs';
import {digest} from '../../engine/knowledge-state.mjs';
function fixture(t){const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-sources-'));t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  fs.mkdirSync(path.join(wsRoot,'docs'));fs.writeFileSync(path.join(wsRoot,'docs/a.md'),'Original source material.');return {wsRoot,policy:{localEnabled:true,allowedRoots:['docs']}};}
test('sources require authorized roots and preserve exact hash and locator',async t=>{
  const f=fixture(t);const result=await collectLocalSources({...f,sources:[{kind:'file',path:'docs/a.md'}]});
  assert.equal(result[0].hash,digest('Original source material.'));assert.equal(result[0].locator,'docs/a.md');
  await assert.rejects(collectLocalSources({...f,policy:{localEnabled:true,allowedRoots:[]},sources:[{kind:'file',path:'docs/a.md'}]}),{code:'source_not_authorized'});
});
test('traversal credentials and junctions cannot be used as sources',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.wsRoot,'docs/.token'),'secret');fs.mkdirSync(path.join(f.wsRoot,'outside'));
  fs.writeFileSync(path.join(f.wsRoot,'outside/b.md'),'outside');fs.symlinkSync(path.join(f.wsRoot,'outside'),path.join(f.wsRoot,'docs/link'),'junction');
  for(const p of ['../secret','docs/.token','docs/link/b.md'])await assert.rejects(collectLocalSources({...f,sources:[{kind:'file',path:p}]}));
});
test('source quotas reject oversize and changed content',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.wsRoot,'docs/b.md'),'a'.repeat(1024*1024+1));
  await assert.rejects(collectLocalSources({...f,sources:[{kind:'file',path:'docs/b.md'}]}),{code:'source_too_large'});
  await assert.rejects(collectLocalSources({...f,sources:Array(6).fill({kind:'file',path:'docs/a.md'})}),{code:'source_limit'});
  await assert.rejects(collectLocalSources({...f,sources:[{kind:'file',path:'docs/a.md',hash:digest('old')}]}),{code:'source_changed'});
});
test('run sources require same workspace actual message and matching session',async t=>{
  const f=fixture(t);const run={id:'r',sessionId:'s',status:'completed',backgroundRecovery:{scope:f.wsRoot},request:{message:'Actual input'}};
  const sources=[{kind:'run',runId:'r',sessionId:'s'}],runStore={get:()=>run};
  assert.equal((await collectLocalSources({...f,sources,runStore}))[0].text,'Actual input');
  run.sessionId='other';await assert.rejects(collectLocalSources({...f,sources,runStore}),{code:'source_not_authorized'});
  run.sessionId='s';delete run.request;run.input={messagePreview:'title only'};
  await assert.rejects(collectLocalSources({...f,sources,runStore}),{code:'source_missing'});
});
test('run sources include bounded actual output with separate unverified attribution',async t=>{
 const f=fixture(t),runRoot=path.join(f.wsRoot,'ledger');fs.mkdirSync(path.join(runRoot,'events'),{recursive:true});
 const run={id:'r',sessionId:'s',status:'completed',backgroundRecovery:{scope:f.wsRoot},request:{message:'Question'}};
 fs.writeFileSync(path.join(runRoot,'events/r.jsonl'),JSON.stringify({runId:'r',sessionId:'s',seq:1,type:'delta',data:{text:'Actual answer, not independently verified'}})+'\n');
 const result=await collectLocalSources({...f,runRoot,runStore:{get:()=>run},sources:[{kind:'run',runId:'r',sessionId:'s'}]});
 assert.equal(result.length,2);assert.equal(result[1].text,'Actual answer, not independently verified');
 assert.equal(result[1].authority,'model_output');assert.equal(result[1].reference.kind,'run_result');
 fs.writeFileSync(path.join(runRoot,'events/r.jsonl'),JSON.stringify({runId:'other',sessionId:'s',seq:1,type:'delta',data:{text:'foreign'}})+'\n');
 await assert.rejects(collectLocalSources({...f,runRoot,runStore:{get:()=>run},sources:[{kind:'run_result',runId:'r',sessionId:'s'}]}),{code:'source_missing'});
});
test('attachment authority requires a terminal non-knowledge run and matching scope',async t=>{
 const f=fixture(t);f.policy.allowedRoots=[];
 const run={id:'r',sessionId:'s',status:'running',backgroundRecovery:{scope:f.wsRoot},request:{message:'input',files:[{path:'docs/a.md'}]}};
 const sources=[{kind:'file',path:'docs/a.md',runId:'r',sessionId:'s'}],runStore={get:()=>run};
 await assert.rejects(collectLocalSources({...f,sources,runStore}),{code:'source_not_authorized'});
 run.status='completed';run.request.origin='knowledge';
 await assert.rejects(collectLocalSources({...f,sources,runStore}),{code:'source_not_authorized'});
 delete run.request.origin;
 assert.equal((await collectLocalSources({...f,sources,runStore})).length,1);
 run.status='failed';assert.equal((await collectLocalSources({...f,sources,runStore})).length,1);
});
