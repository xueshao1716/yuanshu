import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initFileLock } from '../../engine/file-lock.mjs';
import { createKnowledgeStore } from '../../engine/knowledge-store.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-knowledge-'));
  initFileLock({dir:path.join(wsRoot,'locks')});
  t.after(() => fs.rmSync(wsRoot,{recursive:true,force:true}));
  let clock = 1_800_000_000_000;
  const opts = {wsRoot,now:()=>clock,leaseMs:100};
  return {wsRoot,store:createKnowledgeStore(opts),other:createKnowledgeStore(opts),advance:ms=>clock+=ms};
}
const input = extra => ({sourceId:'run:r1',sourceVersion:hash('v1'),event:'completed',runId:'r1',sessionId:'s1',sources:[],...extra});
const guard = job => ({revision:job.revision,generation:job.generation,owner:job.lease.owner,policyRevision:job.policyRevision});

test('knowledge defaults are local-only and persistent outputs are detached',async t=>{
  const {store}=fixture(t); const p=await store.policy();
  assert.equal(p.remoteEnabled,false); assert.equal(p.networkEnabled,false); assert.equal(p.dailyCost,0);
  p.allowedRoots.push('C:/'); assert.deepEqual((await store.policy()).allowedRoots,[]);
  await assert.rejects(store.updatePolicy({dailyCost:-1},1),{code:'invalid_policy'});
  await store.updatePolicy({paused:true},1);
  await assert.rejects(store.updatePolicy({paused:false},1),{code:'revision_conflict'});
});
test('knowledge identities separate session, source versions, events and workspaces',async t=>{
  const {store}=fixture(t); const a=await store.enqueue(input());
  assert.equal((await store.enqueue(input())).id,a.id);
  assert.notEqual((await store.enqueue(input({sessionId:'s2'}))).id,a.id);
  assert.notEqual((await store.enqueue(input({sourceVersion:hash('v2')}))).id,a.id);
  assert.notEqual((await store.enqueue(input({event:'failed'}))).id,a.id);
  const other=fixture(t); assert.notEqual((await other.store.enqueue(input())).id,a.id);
  assert.equal((await store.list({limit:2})).items.length,2); assert.equal((await store.list()).total,4);
});
test('knowledge claims are exclusive across instances and lease generations fence stale responses',async t=>{
  const {store,other,advance}=fixture(t); const j=await store.enqueue(input());
  const claims=await Promise.all([store.claim('one'),other.claim('two')]);
  assert.equal(claims.filter(Boolean).length,1); const c=claims.find(Boolean);
  advance(101); const next=await other.claim('new'); assert.equal(next.id,j.id); assert.ok(next.generation>c.generation);
  await assert.rejects(store.transition(j.id,guard(c),{state:'extracting'}),{code:'stale_claim'});
  const n=await other.transition(j.id,guard(next),{state:'extracting'}); assert.equal(n.stage,'extracting');
  await assert.rejects(other.transition(j.id,guard(n),{state:'committed'}),{code:'invalid_transition'});
});
test('pause cancellation and policy revision revoke in-flight authority',async t=>{
  const {store,advance}=fixture(t); const j=await store.enqueue(input()); const c=await store.claim('one');
  const paused=await store.control(j.id,'pause',c.revision); advance(200); await store.recover();
  assert.equal(await store.claim('two'),null); assert.equal((await store.get(j.id)).state,'paused');
  const resumed=await store.control(j.id,'resume',paused.revision); assert.equal(resumed.state,'queued');
  const next=await store.claim('two'); await store.updatePolicy({paused:true},1);
  await assert.rejects(store.transition(j.id,guard(next),{state:'extracting'}),{code:'policy_changed'});
  const current=await store.get(j.id); await store.control(j.id,'cancel',current.revision);
  await store.updatePolicy({paused:false},2); assert.equal(await store.claim('three'),null);
});
test('invalid storage and symlinked metadata fail closed',async t=>{
  const {store,wsRoot}=fixture(t); await store.enqueue(input());
  fs.writeFileSync(path.join(wsRoot,'记忆/知识/state.json'),'{broken');
  await assert.rejects(store.claim('one'),{code:'knowledge_state_unreadable'});
  await assert.rejects(store.get('../../outside'),{code:'invalid_id'});
});
