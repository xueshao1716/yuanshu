import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {directChat,initModelClient} from '../../engine/model-client.mjs';

async function fixture(t,api,handler){
  const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const model={provider:'test',id:'design',api,baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  initModelClient({authPath:'auth',modelsPath:'models',readJsonFile:p=>p==='auth'?{test:{key:'test-key'}}:{},resolveAuth:()=>({baseUrl:model.baseUrl}),getModelList:()=>[model]});
  return model;
}
const frame=e=>`data: ${JSON.stringify(e)}\n\n`;
for(const api of ['anthropic-messages','openai-completions'])test(`${api} exposes progress before completion, never reasoning as answer`,async t=>{
  let release,received;const gate=new Promise(r=>{release=r;});
  const model=await fixture(t,api,async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;received=JSON.parse(raw);res.setHeader('Content-Type','text/event-stream');
    if(api==='anthropic-messages')res.write([
      {type:'message_start',message:{model:'actual'}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'private reasoning'}},
      {type:'content_block_stop',index:0},{type:'content_block_start',index:1,content_block:{type:'text',text:'{"html":'}}
    ].map(frame).join(''));
    else res.write(frame({model:'actual',choices:[{delta:{reasoning_content:'private reasoning',content:'{"html":'}}]}));
    await gate;
    if(api==='anthropic-messages')res.end([
      {type:'content_block_delta',index:1,delta:{type:'text_delta',text:'"ok"}'}},{type:'content_block_stop',index:1},
      {type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}
    ].map(frame).join(''));
    else res.end(frame({model:'actual',choices:[{delta:{content:'"ok"}'},finish_reason:'stop'}]})+'data: [DONE]\n\n');
  });
  const events=[],parts=[];let beforeEnd=false;
  const rescue=setTimeout(release,300);t.after(()=>clearTimeout(rescue));
  const result=await directChat(model,'网页',[],{stream:true,allowPartial:true,throwOnError:true,timeout:2000,idleTimeout:1000,
    onProgress:p=>events.push(p),onDelta:text=>{parts.push(text);if(parts.length===1){beforeEnd=true;release();}}});
  assert.equal(received.stream,true);assert.equal(beforeEnd,true);assert.equal(result.text,'{"html":"ok"}');assert.equal(result.usedModel.id,'actual');
  assert.ok(events.some(e=>e.phase==='thinking'));assert.ok(events.some(e=>e.phase==='output'));assert.ok(!JSON.stringify(events).includes('private reasoning'));
});

test('stream inactivity is bounded and preserves partial output for caller',async t=>{
  const model=await fixture(t,'openai-completions',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write(frame({choices:[{delta:{content:'partial'}}]}));});
  const parts=[];const started=Date.now();
  await assert.rejects(directChat(model,'网页',[],{stream:true,throwOnError:true,allowPartial:true,idleTimeout:60,timeout:1000,onDelta:p=>parts.push(p)}),e=>e.code==='MODEL_IDLE_TIMEOUT');
  assert.deepEqual(parts,['partial']);assert.ok(Date.now()-started<900);
});

test('incomplete SSE with text is not a successful response',async t=>{
  const model=await fixture(t,'openai-completions',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.end(frame({choices:[{delta:{content:'partial'}}]}));});
  await assert.rejects(directChat(model,'网页',[],{stream:true,allowPartial:true,throwOnError:true}),e=>e.code==='MODEL_STREAM_INCOMPLETE');
});

test('active stream still respects overall deadline',async t=>{
  const model=await fixture(t,'openai-completions',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');const timer=setInterval(()=>res.write(frame({choices:[{delta:{reasoning_content:'busy'}}]})),10);
    res.on('close',()=>clearInterval(timer));
  });
  await assert.rejects(directChat(model,'网页',[],{stream:true,allowPartial:true,throwOnError:true,idleTimeout:200,timeout:90}),e=>e.code==='MODEL_DEADLINE');
});

test('cancellation after headers interrupts an otherwise stalled reader',async t=>{
  const controller=new AbortController();
  const model=await fixture(t,'openai-completions',(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write(frame({choices:[{delta:{content:'partial'}}]}));});
  await assert.rejects(directChat(model,'网页',[],{stream:true,allowPartial:true,throwOnError:true,timeout:1000,signal:controller.signal,onDelta:()=>controller.abort(new Error('user stopped'))}),/user stopped/);
});
