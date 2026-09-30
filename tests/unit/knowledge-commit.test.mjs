import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {digest as hash} from '../../engine/knowledge-state.mjs';
const digest=createHash('sha256').update('source').digest('hex');
const guard=j=>({revision:j.revision,generation:j.generation,owner:j.lease.owner,policyRevision:j.policyRevision});
async function setup(t,fault) {
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-commit-'));
  initFileLock({dir:path.join(wsRoot,'locks')});t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  const store=createKnowledgeStore({wsRoot,fault});
  fs.mkdirSync(path.join(wsRoot,'docs'));fs.writeFileSync(path.join(wsRoot,'docs/a.txt'),'source');
  await store.updatePolicy({allowedRoots:['docs']},1);
  const sourceVersion=hash([['docs/a.txt',digest]]),reference={kind:'file',path:'docs/a.txt',hash:digest};
  await store.enqueue({sourceId:'file:a',sourceVersion,event:'manual',sources:[reference],sessionId:'s'});
  let job=await store.claim('one');
  for (const state of ['extracting','validating','ready']) job=await store.transition(job.id,guard(job),{state});
  return {wsRoot,store,job,entry:{kind:'source',text:'source',sourceVersion,sources:[{hash:digest,locator:'docs/a.txt',reference}],verified:false}};
}
test('crash after entry write recovers one deterministic committed entry',async t=>{
  const {wsRoot,store,job,entry}=await setup(t,stage=>{if(stage==='afterEntry')throw Error('crash');});
  await assert.rejects(store.commit(job.id,guard(job),entry),/crash/);
  const recovered=createKnowledgeStore({wsRoot}); await recovered.recover();await recovered.recover();
  assert.equal((await recovered.get(job.id)).state,'committed');
  assert.equal((await recovered.entries()).length,1);
  const saved=(await recovered.entries())[0];
  await recovered.recordUse(saved.id,{runId:'next',sessionId:'s2',result:'used'});
  assert.equal((await recovered.entries())[0].verified,false);
});
test('revocation prevents recovery from exposing a half-committed entry',async t=>{
  const {store,job,entry}=await setup(t,stage=>{if(stage==='afterEntry')throw Error('crash');});
  await assert.rejects(store.commit(job.id,guard(job),entry),/crash/);
  await store.updatePolicy({localEnabled:false},2);await store.recover();
  assert.equal((await store.entries()).length,0);
  assert.notEqual((await store.get(job.id)).state,'committed');
});

test('recovery rechecks source bytes before completing an interrupted commit',async t=>{
 const {wsRoot,store,job,entry}=await setup(t,stage=>{if(stage==='afterEntry')throw Error('crash');});
 await assert.rejects(store.commit(job.id,guard(job),entry),/crash/);
 fs.writeFileSync(path.join(wsRoot,'docs/a.txt'),'changed after crash');
 const recovered=createKnowledgeStore({wsRoot});await recovered.recover();
 assert.equal((await recovered.entries()).length,0);
 assert.equal((await recovered.get(job.id)).state,'blocked');
 assert.equal((await recovered.get(job.id)).reason,'source_changed');
});
test('changed committed bytes are rejected rather than offered as source knowledge',async t=>{
 const {wsRoot,store,job,entry}=await setup(t);
 const committed=await store.commit(job.id,guard(job),entry);
 const file=path.join(wsRoot,'记忆/知识/entries',committed.entryId+'.json');
 const record=JSON.parse(fs.readFileSync(file));record.text='tampered';fs.writeFileSync(file,JSON.stringify(record));
 await assert.rejects(store.entries(),{code:'knowledge_journal_invalid'});
});
test('entry validation cooperatively yields and still rejects changed journal bytes',async t=>{
 const {wsRoot,store,job,entry}=await setup(t);await store.commit(job.id,guard(job),entry);
 let yielded=false;const otherWork=new Promise(resolve=>setImmediate(()=>{yielded=true;resolve();}));
 const entries=await store.entries();assert.equal(yielded,true,'background disk scanning must let foreground tasks run');await otherWork;
 assert.equal(entries.length,1);
 const journal=path.join(wsRoot,'记忆/知识/journal',job.id+'.json');const record=JSON.parse(fs.readFileSync(journal));record.hash='bad';fs.writeFileSync(journal,JSON.stringify(record));
 await assert.rejects(store.entries(),{code:'knowledge_journal_invalid'});
});
