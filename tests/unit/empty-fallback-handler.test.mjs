import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initUnifiedChat, handleUnifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';
import { initModelRouter } from '../../engine/model-router.mjs';
import { initContextLoader } from '../../engine/context-loader.mjs';
import { initYuanshuWorkmem } from '../../engine/yuanshu-workmem.mjs';
import { init as initEmotion } from '../../engine/emotion.mjs';

test('空回复备用模型接续工具进度，切换先通知；失败仍保存备用工具轨迹', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-fallback-handler-'));
  const requests = [], events = [], saved = [], executed = [];
  let announcedBeforeFallback = false;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const primary = body.model === 'fable-fixture';
    const nth = requests.filter(r=>r.model===body.model).length;
    if (!primary && nth === 1) {
      announcedBeforeFallback = events.some(e=>e.type==='model_switched' && e.data.id==='2.5-flash');
    }
    const message = nth === 1
      ? {content:null,tool_calls:[{id:primary?'step1':'step2',type:'function',function:{name:'lookup',arguments:JSON.stringify({step:primary?1:2})}}]}
      : {content:''};
    res.writeHead(200, {'content-type':body.stream?'text/event-stream':'application/json'});
    const json = {choices:[{message,finish_reason:'stop'}]};
    res.end(body.stream ? `data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n` : JSON.stringify(json));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = {api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}`};
  const primary = {...base,provider:'fixture',id:'fable-fixture'};
  const fallback = {...base,provider:'agnes',id:'2.5-flash'};
  const models = [primary, fallback];
  const readJsonFile = f=>f==='auth'
    ? {fixture:{key:'test'},agnes:{key:'test'}}
    : {fixture:{models:[primary]},agnes:{models:[fallback]}};
  initDshKeys({authPath:'auth',modelsPath:'models',readJsonFile});
  initModelRouter({getModelList:()=>models,getDefaultModel:()=>primary});
  initContextLoader({cwd:root}); initYuanshuWorkmem(root); initEmotion(root);
  initUnifiedChat({authPath:'auth',modelsPath:'models',readJsonFile,getModelList:()=>models,
    getDefaultModel:()=>primary,cwd:root,sessionDir:root,getAgentDir:()=>root,
    UNIFIED_TOOLS:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],
    executeUnifiedTool:async(name,args)=>{executed.push(args.step);return {text:`evidence-${args.step}`};}});
  try {
    const entry = {modelKey:primary,sm:{appendMessage:m=>saved.push(m),getTree:()=>[],getSessionName:()=>'test'}};
    await handleUnifiedChat(null, entry, '查询结果', 'empty-fallback-test', {}, undefined,
      {push:(type,data)=>events.push({type,data})}, false, 'empty-fallback-test', primary);
    const backupRequest = requests.find(r=>r.model===fallback.id);
    assert.ok(announcedBeforeFallback, '备用请求之前必须通知切换');
    assert.ok(backupRequest.messages.some(m=>m.role==='tool' && m.content.includes('evidence-1')));
    assert.deepEqual(executed, [1,2]);
    assert.ok(saved.some(m=>m.role==='toolResult' && m.toolCallId==='step1'));
    assert.ok(saved.some(m=>m.role==='toolResult' && m.toolCallId==='step2'));
    assert.ok(events.some(e=>e.type==='error' && e.data.message.includes('备用 agnes/2.5-flash')));
    assert.ok(!events.some(e=>e.type==='done'), '双模型空不能伪报成功');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
