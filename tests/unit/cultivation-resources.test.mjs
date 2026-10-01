import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initFileLock} from '../../engine/file-lock.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeBudget} from '../../engine/knowledge-budget.mjs';

async function setup(t) {
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-cultivation-resources-'));
  initFileLock({dir:path.join(wsRoot,'locks')});
  t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  let clock=Date.UTC(2026,8,30,12);
  const opts={wsRoot,now:()=>clock}, store=createKnowledgeStore(opts);
  const policy=await store.updatePolicy({remoteEnabled:true,dailyCost:1,maxModelRequests:4},1);
  return {opts,policy,budget:createKnowledgeBudget(opts),advance:()=>clock+=86400000};
}
const limits={dailyRequests:1,dailyBudgetCents:60};
test('cultivation shares the knowledge journal and cannot bypass its own quota',async t=>{
  const {opts,policy,budget}=await setup(t);
  const row=await budget.reserve({kind:'model',policy,maxCost:0.6,currency:'USD',consumer:'cultivation',limits});
  assert.equal(row.consumer,'cultivation');
  const restarted=createKnowledgeBudget(opts);
  await assert.rejects(restarted.reserve({kind:'model',policy,maxCost:0.1,currency:'USD',consumer:'cultivation',limits}),{code:'cultivation_request_limit'});
  await assert.rejects(restarted.reserve({kind:'model',policy,maxCost:0.5,currency:'USD'}),{code:'budget_exhausted'});
  assert.equal((await restarted.status()).reserved,0.6);
});
test('cultivation requires explicit limits, cannot forge consumer or exceed cents budget',async t=>{
  const {policy,budget}=await setup(t);
  for(const input of [{consumer:'child'},{consumer:'cultivation'},{consumer:'cultivation',limits:{...limits,dailyRequests:NaN}}])
    await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0.1,currency:'USD',...input}),{code:'invalid_budget'});
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0.61,currency:'USD',consumer:'cultivation',limits}),{code:'cultivation_budget_exhausted'});
  assert.equal((await budget.status()).modelRequests,0);
});
test('uncertain reservations remain held after UTC rollover',async t=>{
  const {policy,budget,advance}=await setup(t);
  const r=await budget.reserve({kind:'model',policy,maxCost:0.8,currency:'USD'});
  await budget.settle(r.id,null);advance();
  assert.equal((await budget.status()).reserved,0.8);
  await assert.rejects(budget.reserve({kind:'model',policy,maxCost:0.3,currency:'USD'}),{code:'budget_exhausted'});
});
