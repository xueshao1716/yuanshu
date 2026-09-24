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
