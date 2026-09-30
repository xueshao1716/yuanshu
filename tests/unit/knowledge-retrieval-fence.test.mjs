import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createRunStore} from '../../engine/run-store.mjs';
import {createKnowledgeRuntime} from '../../engine/knowledge-runtime.mjs';
import {createKnowledgeRetrieval} from '../../engine/knowledge-retrieval.mjs';

async function fixture(t){
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-retrieval-fence-'));
  t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  initFileLock({dir:path.join(wsRoot,'locks')});
  const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});
  fs.mkdirSync(path.join(wsRoot,'docs'));
  fs.writeFileSync(path.join(wsRoot,'docs/first.txt'),'配置端口：8787');
  fs.writeFileSync(path.join(wsRoot,'docs/second.txt'),'配置端口：9999');
  const r=createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog:()=>[],directChat:()=>assert.fail('no provider')});
  t.after(()=>r.close());
  await r.updatePolicy({allowedRoots:['docs']},1);
  await r.enqueue({kind:'file',path:'docs/first.txt'},2);await r.worker.tick();
  assert.equal((await r.context({query:'配置端口',sessionId:'s'})).entries.length,1);
  return {r,wsRoot,entry:(await r.store.entries())[0]};
}

for(const status of ['conflict','superseded'])test(`current ${status} status fences a cached active entry before refresh`,async t=>{
  const {r,entry}=await fixture(t);
  const refresh=r.retrieval.refresh;r.retrieval.refresh=async()=>{};
  const second=await r.enqueue({kind:'file',path:'docs/second.txt'},2);await r.worker.tick();
  const review=await r.store.get(second.id);assert.equal(review.state,'review_required');
  if(status==='superseded'){
    await r.review(second.id,{decision:'accept_source',confirmed:true,note:'核对后选择新来源'},review.revision,2);
    await r.worker.tick();assert.equal((await r.store.get(second.id)).state,'committed');
  }
  assert.equal((await r.store.entries()).find(e=>e.id===entry.id).status,status);
  const entries=r.store.entries;r.store.entries=async()=>assert.fail('foreground must not scan entry files');
  const out=await r.context({query:'配置端口',sessionId:'s'});
  assert.deepEqual(out.entries,[]);assert.equal(out.context,'');
  r.store.entries=entries;r.retrieval.refresh=refresh;await refresh();
  if(status==='superseded')assert.match((await r.context({query:'配置端口',sessionId:'s'})).context,/9999/);
});

test('status changed during source verification is fenced at return',async t=>{
  const {r,entry}=await fixture(t);
  const retrieval=createKnowledgeRetrieval({store:r.store,verifySource:async()=>{
    await r.store.invalidateEntry(entry.id,'conflict');return true;
  }});
  await retrieval.refresh();const out=await retrieval.retrieve({query:'配置端口',sessionId:'s'});
  assert.deepEqual(out.entries,[]);assert.equal(out.context,'');
});

test('cached entry must still match its committed source identity',async t=>{
  const {r,entry}=await fixture(t);
  const retrieval=createKnowledgeRetrieval({store:{...r.store,entries:async()=>[{...entry,sourceVersion:'0'.repeat(64)}]},verifySource:async()=>true});
  await retrieval.refresh();const out=await retrieval.retrieve({query:'配置端口',sessionId:'s'});
  assert.equal(out.available,false);assert.deepEqual(out.entries,[]);
});

test('retrieval cannot silently bypass a missing authoritative fence',async t=>{
  const {entry}=await fixture(t);
  const retrieval=createKnowledgeRetrieval({store:{entries:async()=>[entry],policy:async()=>({revision:2})},verifySource:async()=>true});
  await retrieval.refresh();const out=await retrieval.retrieve({query:'配置端口',sessionId:'s'});
  assert.equal(out.available,false);assert.deepEqual(out.entries,[]);
});
