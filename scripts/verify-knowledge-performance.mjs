// Isolated acceptance benchmark; no production state, network or paid provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {initFileLock} from '../engine/file-lock.mjs';
import {createRunStore} from '../engine/run-store.mjs';
import {createKnowledgeRuntime} from '../engine/knowledge-runtime.mjs';
import {knowledgeChatContext} from '../engine/knowledge-chat.mjs';
import {createCultivationStorage} from '../engine/cultivation/storage.mjs';
import {createIdentityAuthority} from '../engine/cultivation/identity.mjs';
import {createCultivationControls} from '../engine/cultivation/controls.mjs';
import {createCultivationTasks} from '../engine/cultivation/tasks.mjs';
import {draft,enabledPolicy} from '../tests/helpers/cultivation-fixture.mjs';
import {randomUUID} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-knowledge-performance-'));
const cultivation=process.argv.includes('--cultivation');
const output=path.join(root,`tmp/${cultivation?'cultivation':'knowledge'}-performance.json`);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const p95=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]||0;
let foreground=false,providerCalls=0,cultivationCalls=0,inFlight=0,maxInFlight=0,runtime,tasks;
const latency=async()=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{await wait(2);}finally{inFlight--;}};
try{
  initFileLock({dir:path.join(wsRoot,'locks')});
  const runRoot=path.join(wsRoot,'ledger'),runStore=createRunStore({rootDir:runRoot});
  fs.mkdirSync(path.join(wsRoot,'docs'));
  const model={provider:'fixture',id:'text',enabled:true,capabilities:['text']};
  runtime=createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog:()=>[model],foregroundBusy:()=>foreground,
    directChat:async(_model,message)=>{
      providerCalls++;await latency();
      const source=JSON.parse(message)[0];
      return {text:JSON.stringify({kind:'source',text:source.text.slice(0,100),sourceId:source.id,
        sourceHash:source.hash,offset:source.offset||0,scope:'隔离性能夹具'}),usedModel:model,
        usage:{input_tokens:100,output_tokens:50}};
    }});
  await runtime.updatePolicy({allowedRoots:['docs']},1);
  // Real commits populate source snapshots, journals and the cached retrieval index.
  for(let i=0;i<60;i++){
    const file=`docs/reference-${i}.txt`;
    fs.writeFileSync(path.join(wsRoot,file),`网络配置参考${i}。核对连接状态、保存记录并明确适用环境。`+'背景资料。'.repeat(20));
    await runtime.enqueue({kind:'file',path:file},2);
    const result=await runtime.worker.tick();assert.equal(result.state,'committed');
  }
  await runtime.updatePolicy({remoteEnabled:true,model:'fixture/text',allowedModels:['fixture/text'],outboundRoots:['docs'],
    maxModelRequests:1000,rates:{'fixture/text':{input:0,output:0,currency:'USD',free:true,tokenBound:'utf8-bytes'}}},2);
  for(let i=0;i<240;i++){
    const file=`docs/pending-${i}.txt`;
    fs.writeFileSync(path.join(wsRoot,file),`隔离任务${i}记录。用于验证后台处理与前台检索共同运行的延迟。`+'一般资料。'.repeat(80));
    await runtime.enqueue({kind:'file',path:file},3);
  }
  if(cultivation){
    // Synthetic identities are confined to this temporary benchmark workspace.
    const store=createCultivationStorage({wsRoot}),human={},mother={};
    const authority=createIdentityAuthority({workspace:store.workspace,
      resolveHuman:s=>s===human?{actorId:'benchmark-human',originId:'benchmark-grant'}:null,
      resolveMother:s=>s===mother?{actorId:'benchmark-mother',originId:'benchmark-run'}:null});
    const controls=createCultivationControls({store,authority});
    const command=(action,payload)=>({action,payload,requestId:randomUUID(),expectedRevision:controls.read().revision});
    const execute=(c,kind)=>controls.execute(c,authority.issue(kind,kind==='human'?human:mother,c));
    await execute(command('policy.set',{policy:{...enabledPolicy(),dailyRequests:1000,
      expiresAt:new Date(Date.now()+86400000).toISOString(),
      schedule:{timezone:'UTC',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440}}}),'human');
    const design=await execute(command('design.submit',{design:draft()}),'mother');
    const agent=await execute(command('agent.register',{designId:design.result.id}),'mother');
    tasks=createCultivationTasks({wsRoot,store,controls,authority,knowledge:runtime.store,
      budget:runtime.budget,admission:runtime.admission,foregroundBusy:()=>foreground,
      provider:{prepare:async()=>({maxCost:0,currency:'USD',free:true,remote:false}),
        invoke:async({guard})=>{guard();cultivationCalls++;await latency();return {text:'Synthetic bounded result',usage:{cost:0,currency:'USD'}};}}});
    for(let i=0;i<80;i++){
      const c=command('run.submit',{agentId:agent.result.id,input:`Synthetic input ${i}`,goal:'Check fixture',criterion:'Bounded text'});
      await tasks.execute(c,authority.issue('mother',mother,c));
    }
  }
  const run=runStore.create({sessionId:'performance',clientRequestId:'foreground',message:'网络配置',backgroundRecovery:{scope:wsRoot}});
  const request=async()=>{
    const start=performance.now();foreground=true;
    try{
      const context=await knowledgeChatContext(runtime,{query:'网络配置',sessionId:run.sessionId,runId:run.id});
      assert.ok(context.includes('[知识:'),'benchmark must exercise real nonempty retrieval');
      // Fixed foreground first-response substitute, identical in both samples.
      await wait(2);return performance.now()-start;
    }finally{foreground=false;}
  };
  for(let i=0;i<10;i++)await request();
  const baseline=[];for(let i=0;i<120;i++)baseline.push(await request());
  const delay=monitorEventLoopDelay({resolution:10});delay.enable();
  let stop=false,workerError=null,ticks=0,commits=0;
  const background=(async()=>{
    while(!stop){
      const result=await runtime.worker.tick();ticks++;if(result.state==='committed')commits++;
      await wait(50);
    }
  })().catch(error=>{workerError=error;});
  const cultivationBackground=(async()=>{
    if(!tasks)return;
    while(!stop){await tasks.tick();await wait(57);}
  })().catch(error=>{workerError=error;});
  const concurrent=[],start=performance.now();
  while(performance.now()-start<60000){concurrent.push(await request());await wait(35);}
  const durationMs=performance.now()-start;stop=true;await Promise.all([background,cultivationBackground]);delay.disable();
  if(workerError)throw workerError;
  const sharedUsage=await runtime.budget.status();
  assert.equal(maxInFlight,1,'shared admission must serialize both background consumers');
  assert.equal(sharedUsage.modelRequests,providerCalls+cultivationCalls,'both consumers must use the same durable ledger');
  if(cultivation)assert.ok(cultivationCalls>0,'cultivation must actually dispatch');
  const metrics={baselineP95Ms:p95(baseline),concurrentP95Ms:p95(concurrent),additionalP95Ms:p95(concurrent)-p95(baseline),
    eventLoopP95Ms:delay.percentile(95)/1e6,eventLoopMaxMs:delay.max/1e6,durationMs,ticks,commits,providerCalls,cultivationCalls,maxInFlight,sharedUsage};
  const report={at:new Date().toISOString(),hardware:{cpu:os.cpus()[0]?.model,cores:os.cpus().length,memoryGiB:os.totalmem()/2**30,
    os:os.platform(),arch:os.arch(),node:process.version},conditions:{seedCommitted:60,seedQueued:240,sourceBytesMax:3000,
    provider:'local deterministic 2ms fixture, no network',foreground:'knowledgeChatContext -> runtime.context -> real ledger + 2ms first response',
    baselineRequests:baseline.length,concurrentRequests:concurrent.length,pressureSeconds:60,fullChatProvider:false},metrics,
    samples:{baselineMs:baseline,concurrentMs:concurrent},passed:baseline.length>=100&&concurrent.length>=100&&durationMs>=60000&&commits>0&&providerCalls>0&&metrics.additionalP95Ms<=100&&metrics.eventLoopP95Ms<=50};
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,samples:undefined},null,2));
  assert.ok(report.passed,`Knowledge performance acceptance failed; see ${output}`);
}finally{
  await runtime?.close();
  // Only the exact temporary directory created above may be removed.
  assert.ok(path.basename(wsRoot).startsWith('yuanshu-knowledge-performance-')&&path.dirname(wsRoot)===os.tmpdir());
  fs.rmSync(wsRoot,{recursive:true,force:true});
}
