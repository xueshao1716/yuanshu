import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {controlFixture, enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {createKnowledgeStore} from '../../engine/knowledge-store.mjs';
import {createKnowledgeBudget} from '../../engine/knowledge-budget.mjs';
import {createBackgroundAdmission} from '../../engine/background-admission.mjs';

const now=()=>Date.parse('2026-09-30T12:00:00Z');
async function fixture(t){
  const url=new URL('../../engine/cultivation/tasks.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'bounded cultivation task service exists');
  const {createCultivationTasks}=await import(url);
  const f=await controlFixture(t,{controls:{now}}),{agentId}=await f.register();
  const policy={...enabledPolicy(),dailyRequests:10,schedule:{timezone:'UTC',days:[3],startMinute:0,endMinute:1440}};
  await f.execute(f.command('policy.set',{policy}));
  const knowledge=createKnowledgeStore({wsRoot:f.root,now}),budget=createKnowledgeBudget({wsRoot:f.root,now});
  await knowledge.updatePolicy({remoteEnabled:true,maxModelRequests:10},1);
  let busy=false,calls=0,answer=async()=>({text:'Synthetic result',usage:{cost:0,currency:'USD'}});
  const admission=createBackgroundAdmission({wsRoot:f.root,now,foregroundBusy:()=>busy});
  const provider={prepare:async()=>({maxCost:0,currency:'USD',free:true,remote:false}),
    invoke:async args=>{calls++;return answer(args);}};
  const options={store:f.store,controls:f.controls,authority:f.authority,wsRoot:f.root,
    knowledge,budget,admission,provider,now,foregroundBusy:()=>busy};
  const tasks=createCultivationTasks(options);
  const submit=()=>f.command('run.submit',{agentId,input:'Only this explicit input',goal:'Check result',criterion:'A bounded textual result'});
  const execute=(c,kind='mother')=>tasks.execute(c,f.authority.issue(kind,kind==='mother'?f.mother:f.human,c));
  return {...f,agentId,tasks,options,submit,execute,admission,budget,knowledge,
    calls:()=>calls,busy:v=>{busy=v;},answer:v=>{answer=v;}};
}

test('tasks persist before dispatch; retry is idempotent and foreground blocks calls',async t=>{
  const f=await fixture(t),c=f.submit(),a=await f.execute(c);
  assert.equal((await f.execute(c)).result.id,a.result.id);
  assert.equal(f.calls(),0);f.busy(true);await f.tasks.tick();assert.equal(f.calls(),0);
  f.busy(false);await f.tasks.tick();assert.equal(f.calls(),1);
  const run=f.tasks.get(a.result.id);assert.equal(run.status,'completed');
  assert.equal(run.cultivation.output,'Synthetic result');assert.equal(run.resumeAvailable,false);
  assert.equal((await f.budget.status()).modelRequests,1);
  await f.tasks.tick();assert.equal(f.calls(),1);
  assert.equal(f.tasks.list().items.length,1);
});

test('shared authorization revoked during final preparation prevents dispatch',async t=>{
  const f=await fixture(t);
  f.options.provider.invoke=async({guard})=>{
    await f.knowledge.updatePolicy({remoteEnabled:false,allowedModels:[]},2);
    guard();return {text:'Must not complete',usage:{cost:0,currency:'USD'}};
  };
  const submitted=await f.execute(f.submit());await f.tasks.tick();
  assert.notEqual(f.tasks.get(submitted.result.id).status,'completed');
  assert.equal(f.tasks.get(submitted.result.id).cultivation.output,null);
});

test('cancel retains slot until the underlying request actually settles',async t=>{
  const f=await fixture(t);let finish,started;
  const ready=new Promise(r=>{started=r;});
  f.answer(({signal})=>new Promise(resolve=>{finish=()=>resolve({text:'Late output',usage:null});started(signal);}));
  const submitted=await f.execute(f.submit()),work=f.tasks.tick(),signal=await ready;
  const c=f.command('run.cancel',{runId:submitted.result.id});await f.execute(c,'human');
  assert.equal(signal.aborted,true);assert.equal((await f.admission.status()).state,'held');
  assert.equal(f.tasks.get(submitted.result.id).status,'stopping');
  finish();await work;assert.equal(f.tasks.get(submitted.result.id).status,'stopped');
  assert.equal(f.tasks.get(submitted.result.id).cultivation.output,null);
  assert.equal((await f.admission.status()).state,'idle');assert.equal((await f.budget.status()).unknown,1);
});

test('changed policy blocks queued dispatch and invalid or forged commands do not enqueue',async t=>{
  const f=await fixture(t),c=f.submit();
  await assert.rejects(f.execute(c,'human'),/identity_denied/);
  await assert.rejects(f.execute({...c,payload:{...c.payload,tools:['shell']}}),/invalid_command/);
  await f.execute(c);
  const pause=f.command('agent.pause',{agentId:f.agentId});
  await f.controls.execute(pause,f.authority.issue('human',f.human,pause));
  await f.tasks.tick();assert.equal(f.calls(),0);assert.equal(f.tasks.list().items[0].status,'stopped');
});

test('crash recovery marks an in-flight task unknown without replay or budget refund',async t=>{
  const f=await fixture(t),r=await f.execute(f.submit());
  const file=path.join(f.root,'工程/智能体培养/tasks/runs',r.result.id+'.json');
  const row=JSON.parse(fs.readFileSync(file));row.status='running';row.ownerId='dead-host';
  fs.writeFileSync(file,JSON.stringify(row));
  const {createCultivationTasks}=await import('../../engine/cultivation/tasks.mjs');
  const restarted=createCultivationTasks(f.options);await restarted.recover();await restarted.tick();
  assert.equal(restarted.get(r.result.id).status,'interrupted');
  assert.equal(restarted.get(r.result.id).resumeAvailable,false);assert.equal(f.calls(),0);
});

test('outside-window work waits without consuming a request',async t=>{
  const f=await fixture(t);
  const c=f.command('policy.set',{policy:{...f.controls.read().data.policy,
    schedule:{timezone:'UTC',days:[4],startMinute:0,endMinute:1440}}});
  await f.controls.execute(c,f.authority.issue('human',f.human,c));
  const submitted=await f.execute(f.submit());await f.tasks.tick();
  assert.equal(f.tasks.get(submitted.result.id).status,'queued');
  assert.equal(f.tasks.get(submitted.result.id).cultivation.reason,'cultivation_outside_window');
  assert.equal(f.calls(),0);assert.equal((await f.budget.status()).modelRequests,0);
});

test('cancellation during preparation never gets overwritten by dispatch',async t=>{
  const f=await fixture(t);let finish,started;
  const ready=new Promise(r=>{started=r;});
  f.options.provider.prepare=()=>new Promise(resolve=>{finish=()=>resolve({maxCost:0,currency:'USD',free:true,remote:false});started();});
  const submitted=await f.execute(f.submit()),work=f.tasks.tick();await ready;
  await f.execute(f.command('run.cancel',{runId:submitted.result.id}),'human');
  finish();await work;
  assert.equal(f.calls(),0);assert.equal(f.tasks.get(submitted.result.id).status,'stopped');
  assert.equal((await f.budget.status()).modelRequests,0);
});

test('task pagination is bounded and rejects stale cursors',async t=>{
  const f=await fixture(t);await f.execute(f.submit());await f.execute(f.submit());
  const page=f.tasks.list({limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  assert.equal(f.tasks.list({limit:1,cursor:page.nextCursor}).items.length,1);
  await f.tasks.tick();assert.throws(()=>f.tasks.list({limit:1,cursor:page.nextCursor}),/cursor_stale/);
  assert.throws(()=>f.tasks.list({limit:51}),/invalid_pagination/);
});

test('renamed task records and mutated caller identity fail closed',async t=>{
  const f=await fixture(t),submitted=await f.execute(f.submit());
  const file=path.join(f.root,'工程/智能体培养/tasks/runs',submitted.result.id+'.json');
  const row=JSON.parse(fs.readFileSync(file));row.id='00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(file,JSON.stringify(row));assert.throws(()=>f.tasks.list(),/state_unreadable/);
});

test('repeated task queries do not scan all files and still validate visible records',async t=>{
  const f=await fixture(t),submitted=await f.execute(f.submit());
  f.tasks.list();
  const original=fs.readdirSync;let scans=0;
  const spy=t.mock.method(fs,'readdirSync',(...args)=>{scans++;return original(...args);});
  for(let i=0;i<5;i++){
    assert.equal(f.tasks.get(submitted.result.id).id,submitted.result.id);
    assert.equal(f.tasks.list().items[0].id,submitted.result.id);
  }
  assert.equal(scans,0,'warm display and direct reads must not enumerate the directory');
  spy.mock.restore();
  const file=path.join(f.root,'工程/智能体培养/tasks/runs',submitted.result.id+'.json');
  const row=JSON.parse(fs.readFileSync(file));row.id='00000000-0000-4000-8000-000000000000';
  fs.writeFileSync(file,JSON.stringify(row));assert.throws(()=>f.tasks.list(),/state_unreadable/);
  assert.throws(()=>f.tasks.get(submitted.result.id),/state_unreadable/);
});

test('background reconciliation yields to foreground events while scanning fresh records',async t=>{
  const f=await fixture(t);
  for(let i=0;i<8;i++)await f.execute(f.submit());
  f.busy(true);
  let foregroundServed=false;
  setImmediate(()=>{foregroundServed=true;});
  await f.tasks.tick();
  assert.equal(foregroundServed,true,'record scans must not monopolize the event loop');
  assert.equal(f.calls(),0);
});

test('cancellation while reserving budget never invokes the provider',async t=>{
  const f=await fixture(t);let finish,started;
  const ready=new Promise(r=>{started=r;}),original=f.budget.reserve;
  const budget={...f.budget,reserve:async args=>{const r=await original(args);await new Promise(resolve=>{finish=resolve;started();});return r;}};
  const {createCultivationTasks}=await import('../../engine/cultivation/tasks.mjs');
  const tasks=createCultivationTasks({...f.options,budget});
  const c=f.submit(),submitted=await tasks.execute(c,f.authority.issue('mother',f.mother,c)),work=tasks.tick();await ready;
  const cancel=f.command('run.cancel',{runId:submitted.result.id});
  await tasks.execute(cancel,f.authority.issue('human',f.human,cancel));finish();await work;
  assert.equal(f.calls(),0);assert.equal(tasks.get(submitted.result.id).status,'stopped');
  assert.equal((await f.admission.status()).state,'idle');
});

test('settlement failure leaves an explicit unknown result and does not replay',async t=>{
  const f=await fixture(t),{createCultivationTasks}=await import('../../engine/cultivation/tasks.mjs');
  const tasks=createCultivationTasks({...f.options,budget:{...f.budget,settle:async()=>{throw new Error('synthetic disk failure');}}});
  const c=f.submit(),submitted=await tasks.execute(c,f.authority.issue('mother',f.mother,c));
  await tasks.tick();assert.equal(tasks.get(submitted.result.id).status,'interrupted');
  assert.equal(tasks.get(submitted.result.id).cultivation.reason,'settlement_pending');
  assert.equal(tasks.get(submitted.result.id).cultivation.output,null);
  await tasks.tick();assert.equal(f.calls(),1);assert.equal((await f.budget.status()).unknown,1);
});

test('provider abort rejection keeps the external result unknown',async t=>{
  const f=await fixture(t);let started;
  const ready=new Promise(resolve=>{started=resolve;});
  f.answer(({signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('transport aborted')),{once:true});started();
  }));
  const submitted=await f.execute(f.submit()),work=f.tasks.tick();await ready;
  await f.execute(f.command('run.cancel',{runId:submitted.result.id}),'human');await work;
  const run=f.tasks.get(submitted.result.id);
  assert.equal(run.status,'interrupted');assert.equal(run.cultivation.reason,'outcome_unknown');
  assert.equal((await f.budget.status()).unknown,1);
});

test('shutdown is bounded without releasing an unsettled provider slot',async t=>{
  const f=await fixture(t),{createCultivationTasks}=await import('../../engine/cultivation/tasks.mjs');
  let finish,started;const ready=new Promise(resolve=>{started=resolve;});
  f.answer(()=>new Promise(resolve=>{finish=()=>resolve({text:'Late result',usage:null});started();}));
  const tasks=createCultivationTasks({...f.options,shutdownMs:20});
  const c=f.submit(),submitted=await tasks.execute(c,f.authority.issue('mother',f.mother,c));
  const work=tasks.tick();await ready;
  const closed=await Promise.race([tasks.close().then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(tasks.get(submitted.result.id).cultivation.reason,'outcome_unknown');
  assert.notEqual((await f.admission.status()).state,'idle','unresponsive transport still owns the slot');
  assert.equal(tasks.cancellation(tasks.get(submitted.result.id).cultivation.agentId),'outcome_unknown');
  finish();await work;
  assert.equal(closed,true,'close must return while transport is unresponsive');
  assert.equal(tasks.get(submitted.result.id).cultivation.output,null);
});

test('run.submit 校验失败报出具体字段与期望，不回传输入值',async t=>{
  const {commandValidationDetails}=await import('../../engine/cultivation/control-transition.mjs');
  const f=await fixture(t),c=f.submit();
  const cases=[
    [{...c,payload:{agentId:f.agentId,input:'私密输入原文',goal:'g'}},'payload',/criterion/],
    [(({expectedRevision,...rest})=>rest)(c),'expectedRevision',/revision/],
    [{...c,payload:{...c.payload,goal:'  '}},'payload.goal',/4000/],
  ];
  for(const [cmd,field,expected] of cases){
    const error=await f.execute(cmd).then(()=>null,e=>e);
    const d=commandValidationDetails(error);
    assert.ok(d,`${field} 应得到字段级说明`);
    assert.equal(d.field,field);assert.match(d.expected,expected);
    assert.ok(!JSON.stringify(d).includes('私密输入原文'));
  }
  assert.equal(f.tasks.list().items.length,0);
});

// 2026-10-07 真机：模型明确答复被截断，不该记成 outcome_unknown（会把个体卡在「取消状态未知」）。
test('definite provider failure settles real usage and records failed with the reason',async t=>{
  const f=await fixture(t);
  f.answer(()=>{const e=new Error('cultivation_output_truncated');e.definite=true;e.usage={cost:0.001,currency:'USD'};throw e;});
  const submitted=await f.execute(f.submit());await f.tasks.tick();
  const run=f.tasks.get(submitted.result.id);
  assert.equal(run.status,'failed');assert.equal(run.cultivation.reason,'cultivation_output_truncated');
  const s=await f.budget.status();assert.equal(s.unknown,0);
  assert.notEqual(f.tasks.cancellation(run.cultivation.agentId),'outcome_unknown');
});
