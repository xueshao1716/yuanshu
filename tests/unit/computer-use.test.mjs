import test from 'node:test';
import assert from 'node:assert/strict';
import { createComputerUse } from '../../engine/computer-use/controller.mjs';
import { createComputerRoutes } from '../../engine/computer-use/routes.mjs';
import { computerTool, createPiComputerTool } from '../../engine/computer-use/tools.mjs';
import registry from '../../engine/tools/confirm-registry.mjs';

function fixture() {
  let now = 1000, changed = false;
  const calls = [];
  const window = { handle:'100', pid:10, started:'start', title:'Fixture', process:'notepad' };
  const adapter = { supported:true, windows:async()=>[window], observe:async()=>({window, elements:[{id:'1.2',name:changed?'Changed':'Body',type:'Edit',value:'before',actions:['type','click']}] }),
    act:async(args)=>{calls.push(args); return {ok:true};} };
  const service = createComputerUse({adapter,registry,now:()=>now,sessionExists:s=>s==='s1'||s==='s2'});
  return {service,adapter,calls,change:()=>{changed=true;},advance:()=>{now+=700000;},async enable(){ const list=await service.windows(); await service.grant({windowId:list[0].id,sessionId:'s1'});return service.observe('s1');}};
}

test('stop invalidates both displayed candidates and window requests already in flight',async()=>{
  const f=fixture();const list=await f.service.windows();f.service.stop();
  await assert.rejects(()=>f.service.grant({windowId:list[0].id,sessionId:'s1'}),/过期/);
  let finish;f.adapter.windows=()=>new Promise(resolve=>{finish=resolve;});
  const job=f.service.windows();const rejected=assert.rejects(job,/停止|变化/);
  f.service.stop();finish([{title:'late',process:'notepad'}]);await rejected;
  assert.equal(f.service.status().enabled,false);
});

test('fresh native observations ignore JSON object key order but not content',async()=>{
  const f=fixture(),seen=await f.enable();
  const original=f.adapter.observe;
  f.adapter.observe=async(...args)=>{const r=await original(...args);return {elements:r.elements.map(e=>({actions:e.actions,value:e.value,type:e.type,name:e.name,id:e.id})),window:r.window};};
  const job=f.service.act('s1',{action:'click',observationId:seen.observationId,elementId:'1.2'});
  await new Promise(r=>setImmediate(r));
  registry.settle('s1',registry.list().find(x=>x.toolName==='computer-use').id,true);
  await job;assert.equal(f.calls.length,1);
});

test('invalid session never reaches the session lookup',async()=>{
  const service=createComputerUse({adapter:{supported:true},registry,sessionExists:()=>{throw new Error('unsafe lookup');}});
  await assert.rejects(()=>service.grant({sessionId:{id:'forged'}}),/请选择有效会话/);
});
test('desktop defaults off and cannot be enabled by tool arguments',async()=>{
  const {service}=fixture(); assert.equal(service.status().enabled,false);
  await assert.rejects(()=>service.observe('s1'),/授权/);
  const result=await computerTool(service,{action:'grant',sessionId:'s1'},{}); assert.equal(result.isError,true);
});
test('single-window grant binds a live session and expires',async()=>{
  const f=fixture();const seen=await f.enable(); assert.ok(seen.observationId);
  assert.equal(f.service.status().grant.scope,'desktop');
  await assert.rejects(()=>f.service.observe('s2'),/会话/);
  f.advance();await assert.rejects(()=>f.service.observe('s1'),/授权/); assert.equal(f.service.status().enabled,false);
});

test('desktop grant keeps its scope when the observation target changes',async()=>{
  const f=fixture(); await f.enable();
  const list=await f.service.windows();
  const status=await f.service.selectWindow({windowId:list[0].id,sessionId:'s1'});
  assert.equal(status.grant.scope,'desktop');
  assert.equal(status.grant.window.title,'Fixture');
});
test('desktop mutation needs approval; consumes observation and rejects replay',async()=>{
  const f=fixture(), seen=await f.enable();
  const job=f.service.act('s1',{action:'type',observationId:seen.observationId,elementId:'1.2',text:'hello'});
  await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,0);
  const pending=registry.list().find(x=>x.toolName==='computer-use');assert.ok(pending.reason.includes('hello'));
  await assert.rejects(()=>f.service.act('s1',{action:'click',observationId:seen.observationId,elementId:'1.2'}),/等待|进行/);
  registry.settle('s1',pending.id,true);await job;assert.equal(f.calls.length,1);
  await assert.rejects(()=>f.service.act('s1',{action:'click',observationId:seen.observationId,elementId:'1.2'}),/观察/);
});
test('denied, cancelled and stale actions never reach desktop adapter',async()=>{
  for(const mode of ['reject','stop','stale','abort']){
    const f=fixture(), seen=await f.enable(), ctrl=new AbortController();
    const job=f.service.act('s1',{action:'click',observationId:seen.observationId,elementId:'1.2'},{signal:ctrl.signal});
    const check=assert.rejects(job);await new Promise(r=>setImmediate(r));
    const p=registry.list().find(x=>x.toolName==='computer-use');
    if(mode==='stop') f.service.stop();
    else if(mode==='abort') ctrl.abort();
    else {if(mode==='stale') f.change();registry.settle('s1',p.id,mode==='stale');}
    await check;assert.equal(f.calls.length,0);assert.equal(registry.list().filter(x=>x.toolName==='computer-use').length,0);
  }
});
test('unknown target, missing session, password and oversized text fail closed',async()=>{
  const f=fixture(), seen=await f.enable();
  for(const args of [{elementId:'bad'},{text:'x'.repeat(2001)},{action:'shell'}]) await assert.rejects(()=>f.service.act('s1',{action:'type',observationId:seen.observationId,elementId:'1.2',text:'ok',...args}));
  assert.equal((await computerTool(f.service,{action:'observe',sessionId:'s1'},{})).isError,true);
  assert.equal(f.calls.length,0);
});
test('desktop routes forbid forwarded and remote requests before touching adapter',async()=>{
  const f=fixture(), output=[];
  const routes=createComputerRoutes({service:f.service,json:(_r,status,body)=>output.push({status,body}),readBody:async()=>({})});
  for(const remoteAddress of ['10.1.2.3','127.0.0.1']){
    const req={socket:{remoteAddress},headers:{host:'localhost:8787',...(remoteAddress==='127.0.0.1'?{'x-forwarded-for':'1.2.3.4'}:{})}};
    await routes.find(x=>x[1]==='/api/computer/windows')[2]({},req);
    assert.equal(output.at(-1).status,403);
  }
});
test('pi adapter takes trusted session from host, never from model arguments',async()=>{
  const calls=[];const service={observe:async sid=>{calls.push(sid);return {};}};
  const Type={Object:x=>x,Union:x=>x,Literal:x=>x,Optional:x=>x,String:()=>({})};
  const tool=createPiComputerTool(Type,service,()=> 'trusted');
  await tool.execute('call',{action:'observe',sessionId:'forged'});
  assert.deepEqual(calls,['trusted']);assert.equal(tool.parallel,false);
});
