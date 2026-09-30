import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeBudget} from '../../engine/knowledge-budget.mjs';
const setup=async t=>{
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-budget-'));
  initFileLock({dir:path.join(wsRoot,'locks')});t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  let clock=Date.UTC(2026,8,30,12);const opts={wsRoot,now:()=>clock};
  const store=createKnowledgeStore(opts),budget=createKnowledgeBudget(opts);
  const policy=await store.updatePolicy({remoteEnabled:true,networkEnabled:true,dailyCost:1,maxModelRequests:2},1);
  return {store,budget,policy,other:createKnowledgeBudget(opts),advance:n=>clock+=n};
};
test('budget reserves atomically across instances and retains unknown usage across restart',async t=>{
  const {budget,other,policy}=await setup(t);
  const results=await Promise.allSettled([budget.reserve({kind:'model',policy,maxCost:0.6,currency:'USD'}),other.reserve({kind:'model',policy,maxCost:0.6,currency:'USD'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const reservation=results.find(r=>r.status==='fulfilled').value;
  await other.settle(reservation.id,null);
  assert.equal((await budget.status()).reserved,0.6);assert.equal((await budget.status()).unknown,1);
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0.6,currency:'USD'}),{code:'budget_exhausted'});
});
test('zero budget and missing prices block calls but explicit free calls consume quota',async t=>{
  const {store,budget}=await setup(t);const policy=await store.updatePolicy({dailyCost:0},2);
  await assert.rejects(budget.reserve({kind:'model',policy,currency:'USD'}),{code:'price_unknown'});
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0,currency:'USD'}),{code:'price_unknown'});
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0.1,currency:'USD'}),{code:'budget_exhausted'});
  await budget.reserve({kind:'model',policy,maxCost:0,currency:'USD',free:true});
  await budget.reserve({kind:'model',policy,maxCost:0,currency:'USD',free:true});
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0,currency:'USD',free:true}),{code:'request_limit'});
});
test('UTC rollover persists high water and currency switches never combine or erase spend',async t=>{
  const {store,budget,policy,advance}=await setup(t);
  const r=await budget.reserve({kind:'model',policy,maxCost:1,currency:'USD'});await budget.settle(r.id,{cost:0.8,currency:'USD'});
  advance(-86400000);assert.equal((await budget.status()).spent,0.8);
  const p2=await store.updatePolicy({currency:'CNY'},2);
  assert.equal((await budget.status()).spent,0);await budget.reserve({kind:'network',policy:p2,maxCost:0,currency:'CNY',free:true});
  await store.updatePolicy({currency:'USD'},3);assert.equal((await budget.status()).spent,0.8);
  advance(2*86400000);assert.equal((await budget.status()).spent,0);assert.equal((await budget.status()).modelRequests,0);
});
test('revoked policy cannot reserve and repeated settlement cannot refund twice',async t=>{
  const {store,budget,policy}=await setup(t);const r=await budget.reserve({kind:'model',policy,maxCost:1,currency:'USD'});
  await budget.settle(r.id,{cost:0.4,currency:'USD'});await budget.settle(r.id,{cost:0,currency:'USD'});
  assert.equal((await budget.status()).spent,0.4);await store.updatePolicy({paused:true},2);
  await assert.rejects(budget.reserve({kind:'network',policy,maxCost:0,currency:'USD',free:true}),{code:'policy_changed'});
});
