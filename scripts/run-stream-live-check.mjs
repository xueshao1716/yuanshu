// Paid opt-in: real model + restricted disk tools + real HTTP/SSE disconnect/replay.
// node scripts/run-stream-live-check.mjs provider/model
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const modelKey=process.argv[2],split=modelKey?.indexOf('/');
if(!(split>0))throw new Error('Specify provider/model explicitly');
const provider=modelKey.slice(0,split),id=modelKey.slice(split+1);
const agent=path.join(os.homedir(),'.pi','agent'),readJsonFile=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const authPath=path.join(agent,'auth.json'),modelsPath=path.join(agent,'models-store.json');
const definition=readJsonFile(modelsPath)[provider]?.models?.find(m=>m.id===id);
if(!definition||!readJsonFile(authPath)[provider]?.key)throw new Error('Configured model and key required');
const model={...definition,provider},root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-stream-live-'));
Object.assign(process.env,{YUANSHU_CWD:root,PI_WEB_CWD:root,PI_WORKSPACE:root,
  YUANSHU_AGENT_DIR:path.join(root,'agent'),PI_WEB_AGENT_DIR:path.join(root,'agent')});
const {initDshKeys}=await import('../engine/dsh-keys.mjs');
const {initUnifiedChat,unifiedChat}=await import('../engine/unified-chat.mjs');
const {createRunManager}=await import('../engine/run-manager.mjs');
const {createRunStore}=await import('../engine/run-store.mjs');
const {createRunEffects}=await import('../engine/run-effects.mjs');
const {createRunEventLog}=await import('../engine/run-event-log.mjs');
const {createRunApi}=await import('../engine/run-api.mjs');
const marker=randomUUID(),receipt=path.join(root,'receipt.json'),executed=[],observations=[];
const properties={token:{type:'string'},total:{type:'number'}};
const tools=[
  {name:'read_fixture',description:'Read the isolated invoice containing prices, discount and secret token.',parameters:{type:'object',properties:{}}},
  {name:'write_receipt',description:'Write one receipt with exact total and token obtained from the invoice.',parameters:{type:'object',properties,required:['token','total']}},
  {name:'read_receipt',description:'Read the saved receipt to verify actual contents.',parameters:{type:'object',properties:{}}},
];
let detach=null,detached=false,finished=false,runId;
initDshKeys({authPath,modelsPath,readJsonFile});
initUnifiedChat({authPath,modelsPath,readJsonFile,getModelList:()=>[model],UNIFIED_TOOLS:tools,
  executeUnifiedTool:async(name,args)=>{
    if(name==='read_fixture'){
      if(detach){detach();detached=true;}
      executed.push(name);return {text:JSON.stringify({token:marker,prices:[19,27,34],discount:12})};
    }
    if(name==='write_receipt'){
      assert.equal(args.token,marker);assert.equal(args.total,68);
      fs.writeFileSync(receipt,JSON.stringify(args),{flag:'wx'});
      executed.push(name);return {text:'Receipt saved. Read it back before answering.'};
    }
    if(name==='read_receipt'){const text=fs.readFileSync(receipt,'utf8');executed.push(name);return {text};}
    throw new Error('Tool not allowed');
  }});
const store=createRunStore({rootDir:root}),effects=createRunEffects({rootDir:root}),eventLog=createRunEventLog({rootDir:root});
const emit=(res,type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
const manager=createRunManager({store,effects,eventLog,instanceId:'stream-live',workspaceScope:()=>root,
  executeChat:async(req,res,body)=>{
    const ctx=body.__runContext,controller=new AbortController();req.once('close',()=>controller.abort());
    try{
      const result=await unifiedChat(model,[{role:'system',content:'这是隔离工具验收，只使用给定工具和真实结果。不得模拟、不得读写其他文件。中文简短回复。'},
        {role:'user',content:body.message}],{tools,maxTurns:8,signal:controller.signal,effects:ctx.effects,
        executionBudgetMs:240000,executionDeadlineAt:Date.now()+240000,
        executionContext:{runId:ctx.runId,sessionId:body.sessionId,attempt:ctx.attempt},
        onCheckpoint:cp=>emit(res,'checkpoint',cp),onDelta:text=>emit(res,'text',{text}),
        onModel:m=>observations.push({provider:m.provider,id:m.id}),
        onTool:(_id,name)=>console.log(JSON.stringify({tool:name})),
      });
      if(result.error)emit(res,'error',{message:result.error});
      else if(result.paused)emit(res,'interrupted',{reason:result.pauseReason});
      res.end();
    }finally{finished=true;}
  }});
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const api=createRunApi({manager,json});
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/events')return api.events(res,req,url,runId);
  res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const report={root,requested:modelKey,protocol:model.api,passed:false,scope:'real_model_tools_http_sse_not_phone_os'};
const subscriber=new AbortController(),first=[];
async function readEvents(response,events){
  let buffer='';const decoder=new TextDecoder();
  for await(const chunk of response.body){
    buffer+=decoder.decode(chunk,{stream:true});let split;
    while((split=buffer.indexOf('\n\n'))>=0){
      const block=buffer.slice(0,split);buffer=buffer.slice(split+2);
      for(const line of block.split('\n'))if(line.startsWith('data:'))events.push(JSON.parse(line.slice(5)));
    }
  }
}
let reading;
try{
  const run=manager.create({sessionId:'acceptance-'+marker,clientRequestId:marker,backgroundRecovery:false,
    message:'先read_fixture读取账单，用价格之和减去优惠计算总价，然后write_receipt写入真实token和总价，再read_receipt读回核实。每个工具恰好一次。最终回复核对后的总价和完整token。'});
  runId=run.id;report.runId=runId;
  const response=await fetch(base+'/events',{signal:subscriber.signal});
  reading=readEvents(response,first).catch(error=>{if(!subscriber.signal.aborted)throw error;});
  detach=()=>subscriber.abort();
  const deadline=Date.now()+250000;
  while(!finished&&Date.now()<deadline)await delay(100);
  if(!finished)manager.stop(runId);
  if(!subscriber.signal.aborted)subscriber.abort();
  await reading;
  const cursor=first.at(-1)?.seq||0,replayed=[];
  await readEvents(await fetch(base+`/events?after=${cursor}`,{signal:AbortSignal.timeout(10000)}),replayed);
  const state=manager.get(runId),events=[...first,...replayed];
  Object.assign(report,{status:state.status,error:state.error,detached,executed,observations,cursor,
    replayCount:replayed.length,effectCount:effects.list(runId).length});
  assert.equal(state.status,'completed');assert.equal(detached,true);assert.ok(cursor>0);
  assert.deepEqual(executed,['read_fixture','write_receipt','read_receipt']);
  assert.equal(effects.list(runId).length,3);
  assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
  assert.ok(replayed.length>0&&replayed.every(e=>e.seq>cursor&&e.runId===runId));
  assert.equal(events.filter(e=>e.type==='completed').length,1);
  assert.deepEqual(events.map(e=>e.seq),manager.readAfter(runId,0).map(e=>e.seq));
  const text=events.filter(e=>e.type==='text').map(e=>e.data?.text||'').join('');
  assert.ok(text.includes(marker)&&text.includes('68'),'Final text must include verified receipt');
  assert.equal(readJsonFile(receipt).total,68);report.passed=true;
}catch(error){report.failure=error.message;process.exitCode=1;}
finally{
  subscriber.abort();await reading?.catch(()=>{});manager.dispose();eventLog.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
