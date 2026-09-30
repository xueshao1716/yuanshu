import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeWorker} from '../../engine/knowledge-worker.mjs';
import {collectLocalSources} from '../../engine/knowledge-sources.mjs';
import {extractLocal,validateCandidate} from '../../engine/knowledge-evidence.mjs';
import {digest,guardFor} from '../../engine/knowledge-state.mjs';

async function fixture(t,options={}) {
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-e2e-'));
  t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  initFileLock({dir:path.join(wsRoot,'locks')});
  fs.mkdirSync(path.join(wsRoot,'docs'));
  fs.writeFileSync(path.join(wsRoot,'docs/source.txt'),'恢复规则：重启后重新核对来源。');
  let clock=1800000000000;
  const now=()=>clock,makeStore=extra=>createKnowledgeStore({wsRoot,now,leaseMs:100,...extra});
  const store=makeStore(options),policy=await store.updatePolicy({allowedRoots:['docs']},1);
  const sources=[{kind:'file',path:'docs/source.txt'}];
  const collect=({job,policy})=>collectLocalSources({wsRoot,sources:job.sources,policy,now});
  const snapshots=await collect({job:{sources},policy});
  const job=await store.enqueue({sourceId:'recovery',event:'manual',sources,
    sourceVersion:digest(snapshots.map(s=>[s.locator,s.hash]))});
  const candidate=extractLocal(snapshots,job);
  const validation=validateCandidate({candidate,snapshots,job,entries:[],now:now()});
  const worker=(s,extra={})=>createKnowledgeWorker({store:s,now,collect,extract:extractLocal,validate:validateCandidate,...extra});
  return {wsRoot,store,job,makeStore,snapshots,candidate,validation,worker,advance:()=>clock+=101};
}

for(const stage of ['collecting','extracting','validating','ready'])test(`restart at ${stage} recovers once and rejects the old lease`,async t=>{
  const f=await fixture(t);let job=await f.store.claim('before-restart');
  for(const state of ['extracting','validating','ready']) {
    if(job.state===stage)break;
    job=await f.store.transition(job.id,guardFor(job),{state,candidate:f.candidate,validation:f.validation});
  }
  f.advance();const store=f.makeStore(),worker=f.worker(store);t.after(()=>worker.stop());
  await worker.tick();await worker.tick();
  assert.equal((await store.get(job.id)).state,'committed');
  assert.equal((await store.entries()).length,1);
  await assert.rejects(f.store.transition(job.id,guardFor(job),{state:'blocked'}),{code:'stale_claim'});
});

for(const boundary of ['afterIntent','afterEntry'])test(`interrupted journal at ${boundary} recovers without a duplicate`,async t=>{
  const f=await fixture(t,{fault:point=>{if(point===boundary)throw Error('simulated crash');}});
  let job=await f.store.claim('before-crash');
  for(const state of ['extracting','validating','ready'])job=await f.store.transition(job.id,guardFor(job),{state});
  await assert.rejects(f.store.commit(job.id,guardFor(job),f.validation.entry),/simulated crash/);
  const restarted=f.makeStore();await restarted.recover();await restarted.recover();
  assert.equal((await restarted.get(job.id)).state,'committed');assert.equal((await restarted.entries()).length,1);
});

test('two real processes cannot claim the same knowledge task',async t=>{
  const f=await fixture(t);
  const script=`import path from 'node:path';
    import {initFileLock} from ${JSON.stringify(new URL('../../engine/file-lock.mjs',import.meta.url).href)};
    import {createKnowledgeStore} from ${JSON.stringify(new URL('../../engine/knowledge-store.mjs',import.meta.url).href)};
    const wsRoot=process.argv[1];initFileLock({dir:path.join(wsRoot,'locks')});
    const store=createKnowledgeStore({wsRoot,now:()=>1800000000000});
    process.send({ready:true});process.once('message',async()=>{
      try{process.send({claim:await store.claim(String(process.pid))});process.disconnect();}
      catch(e){process.send({error:e.code||e.message});process.exitCode=1;process.disconnect();}
    });`;
  const children=[0,1].map(()=>spawn(process.execPath,['--input-type=module','-e',script,f.wsRoot],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true}));
  t.after(()=>children.forEach(c=>{if(c.exitCode===null)c.kill();}));
  const ready=children.map(c=>new Promise((resolve,reject)=>{c.once('message',resolve);c.once('error',reject);}));
  const claims=children.map(c=>new Promise((resolve,reject)=>{c.on('message',m=>{if('claim'in m)resolve(m.claim);if(m.error)reject(Error(m.error));});c.once('error',reject);}));
  const exits=children.map(c=>new Promise(resolve=>c.once('exit',resolve)));
  await Promise.all(ready);children.forEach(c=>c.send('claim'));
  assert.equal((await Promise.all(claims)).filter(Boolean).length,1);
  assert.deepEqual(await Promise.all(exits),[0,0]);
});

test('revoked authorization fences an extraction already in flight',async t=>{
  const f=await fixture(t);let entered,release;
  const started=new Promise(r=>entered=r),waiting=new Promise(r=>release=r);
  const worker=f.worker(f.store,{extract:async()=>{entered();await waiting;return f.candidate;}});t.after(()=>worker.stop());
  const tick=worker.tick();await started;
  await f.store.updatePolicy({allowedRoots:[]},2);release();await tick;
  assert.equal((await f.store.entries()).length,0);
  assert.equal((await f.store.get(f.job.id)).state,'queued');
  await worker.tick();assert.equal((await f.store.get(f.job.id)).state,'blocked');
});
