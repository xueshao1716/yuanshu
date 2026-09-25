import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDirectChatBody, directChat, initModelClient } from "../../engine/model-client.mjs";
import http from 'node:http';

test("关闭思考时请求带 thinking disabled，避免 GLM-5 先想半分钟", () => {
  const body = buildDirectChatBody({
    modelId: "glm-5.3-flash",
    messages: [{ role: "user", content: "hi" }],
    maxTokens: 1600,
    thinking: false,
  });
  assert.equal(body.model, "glm-5.3-flash");
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 1600);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("默认直调不塞 thinking 字段，聊天通道保持原样", () => {
  const body = buildDirectChatBody({
    modelId: "agnes-2.5-flash",
    messages: [],
    maxTokens: 8192,
  });
  assert.equal(body.thinking, undefined);
});

test('工坊严格调用保留上游状态，不把通道 503 伪装为空回复', async () => {
  const server=http.createServer((req,res)=>{res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'private upstream detail'}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const model={provider:'test',id:'design',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  initModelClient({authPath:'auth',modelsPath:'models',readJsonFile:p=>p==='auth'?{test:{key:'test-key'}}:{},resolveAuth:()=>({baseUrl:model.baseUrl}),getModelList:()=>[model]});
  try {
    await assert.rejects(directChat(model,'设计界面',[],{throwOnError:true}),e=>e.statusCode===502 && /HTTP 503/.test(e.message) && !e.message.includes('private'));
    assert.equal(await directChat(model,'设计界面'),null,'兼容旧调用的 null 行为');
  } finally {await new Promise(resolve=>server.close(resolve));}
});

for (const api of ['anthropic-messages','openai-completions','openai-responses']) {
  test(`工坊 ${api} 保留截断正文并尊重模型预算和上下文`, async t => {
    let received;
    const partial=' {"html":"<main class=\"hero ';
    const response=api==='anthropic-messages'
      ? {model:'actual',stop_reason:'max_tokens',content:[{type:'text',text:partial}]}
      : api==='openai-responses'
        ? {model:'actual',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:partial}]}]}
        : {model:'actual',choices:[{finish_reason:'length',message:{content:partial}}]};
    const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;received=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(response));});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
    const model={provider:'test',id:'design',api,maxTokens:24576,baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
    initModelClient({authPath:'auth',modelsPath:'models',readJsonFile:p=>p==='auth'?{test:{key:'test-key'}}:{},resolveAuth:()=>({baseUrl:model.baseUrl}),getModelList:()=>[model]});
    const out=await directChat(model,'继续', [{role:'assistant',content:'前一段'}], {maxTokens:32768,systemHint:'网站设计',allowPartial:true,throwOnError:true});
    assert.equal(received.max_tokens||received.max_output_tokens,24576);
    assert.equal(out.text,partial);assert.equal(out.truncated,true);assert.ok(out.finishReason);assert.equal(out.usedModel.id,'actual');assert.equal(out.outputBudget,24576);
    assert.match(JSON.stringify(received),/网站设计/);assert.match(JSON.stringify(received),/前一段/);
    if(api==='anthropic-messages')assert.equal(await directChat(model,'旧调用'),null);
  });
}

test('工坊正文模式不把推理内容冒充页面',async t=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'',reasoning_content:'这是推理，不是网页'}}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const model={provider:'test',id:'design',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  initModelClient({authPath:'auth',modelsPath:'models',readJsonFile:p=>p==='auth'?{test:{key:'test-key'}}:{},resolveAuth:()=>({baseUrl:model.baseUrl}),getModelList:()=>[model]});
  const out=await directChat(model,'网页',[],{allowPartial:true});assert.equal(out.text,null);assert.match(out.think,/推理/);
  assert.match((await directChat(model,'旧调用')).text,/推理/);
});
