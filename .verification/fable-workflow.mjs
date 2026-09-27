import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initUnifiedChat, unifiedChat} from '../engine/unified-chat.mjs';
import {initDshKeys} from '../engine/dsh-keys.mjs';
const agent='C:/Users/xuexiaofeng/.pi/agent';
const authPath=`${agent}/auth.json`, modelsPath=`${agent}/models-store.json`;
const readJsonFile=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const model={...readJsonFile(modelsPath)['aieyra-claude'].models.find(m=>m.id==='claude-fable-5-1'),provider:'aieyra-claude'};
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-fable-live-'));
const calls=[], models=[], notes=[];
initDshKeys({authPath,modelsPath,readJsonFile});
initUnifiedChat({authPath,modelsPath,readJsonFile,cwd,getModelList:()=>[model],
  UNIFIED_TOOLS:[{type:'function',function:{name:'lookup',description:'Read the value for a named synthetic fixture. Available names alpha and beta.',parameters:{type:'object',properties:{name:{type:'string',enum:['alpha','beta']}},required:['name']}}}],
  executeUnifiedTool:async(name,args)=>{calls.push({name,args});return {text:args.name==='alpha'?'17':'25'};},
});
try {
  const result=await unifiedChat(model,[{role:'system',content:'Use only the supplied lookup tool. Never invent values.'},{role:'user',content:'Look up alpha and beta separately. Sum the two returned values, then give the answer as TOTAL=<number>.'}],{
    maxTurns:5,signal:AbortSignal.timeout(90000),onModel:m=>models.push(m),onNote:n=>notes.push(n),
  });
  const ok=/TOTAL\s*=\s*42/.test(result.text||'')&&new Set(calls.map(c=>c.args.name)).size===2&&!result.error;
  console.log(JSON.stringify({ok,calls,models,notes,text:result.text,error:result.error,empty:result.empty},null,2));
  if(!ok)process.exitCode=1;
}finally{fs.rmSync(cwd,{recursive:true,force:true});}
