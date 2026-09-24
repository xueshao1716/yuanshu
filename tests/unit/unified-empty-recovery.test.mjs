import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { initUnifiedChat, unifiedChat } from '../../engine/unified-chat.mjs';
import { initDshKeys } from '../../engine/dsh-keys.mjs';

test('空SSE使用同一模型非流式恢复，保留工具结果且不重复执行', async () => {
  const requests = [], notes = [], diagnostics = [];
  let executed = 0;
  const server = http.createServer(async (req, res) => {
    let raw=''; for await (const c of req) raw += c;
    const body=JSON.parse(raw); requests.push(body);
    const message = requests.length === 1
      ? { content:null, tool_calls:[{id:'c1',type:'function',function:{name:'lookup',arguments:'{}'}}] }
      : {content:body.stream ? '' : '结果是42'};
    res.writeHead(200,{'content-type':body.stream?'text/event-stream':'application/json'});
    const json={model:'fable-fixture',choices:[{message,finish_reason:'stop'}],usage:{completion_tokens:body.stream?0:5}};
    res.end(body.stream?`data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n`:JSON.stringify(json));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const model={provider:'fixture',id:'fable-fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}`};
  const readJsonFile=f=>f==='auth'?{fixture:{key:'test'}}:{fixture:{models:[model]}};
  initDshKeys({authPath:'auth',modelsPath:'models',readJsonFile});
  initUnifiedChat({authPath:'auth',modelsPath:'models',readJsonFile,getModelList:()=>[model],
    UNIFIED_TOOLS:[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}],
    executeUnifiedTool:async()=>{executed++;return {text:'42'};}});
  try {
    const result=await unifiedChat(model,[{role:'user',content:'查询再回答'}],{
      onNote:n=>notes.push(n), executionContext:{onEvent:(type,data)=>diagnostics.push({type,data})},
    });
    assert.equal(result.text,'结果是42');
    assert.equal(executed,1);
    assert.deepEqual(requests.map(r=>r.stream),[true,true,false]);
    assert.ok(requests[2].messages.some(m=>m.role==='tool'&&m.content.includes('42')));
    assert.equal(result.usedModel.id,model.id);
    assert.ok(notes.some(n=>n.includes('非流式')));
    assert.ok(diagnostics.some(e=>e.type==='model_empty_response'&&e.data.finishReason==='stop'));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

for (const makesProgress of [false, true]) {
  test(makesProgress ? '工具进展重置连续空回复计数' : '连续空回复只重试两次并返回可诊断结果', async () => {
    const requests = [], diagnostics = [];
    let executed = 0;
    const server = http.createServer(async (req, res) => {
      let raw = ''; for await (const c of req) raw += c;
      const body = JSON.parse(raw); requests.push(body);
      const n = requests.length;
      const message = makesProgress && n === 3
        ? {content:null,tool_calls:[{id:'progress',type:'function',function:{name:'lookup',arguments:'{}'}}]}
        : makesProgress && n === 6 ? {content:'完成'} : {content:'',reasoning_content:'仍在分析'};
      res.writeHead(200, {'content-type':body.stream ? 'text/event-stream' : 'application/json'});
      const json = {choices:[{message,finish_reason:'stop'}],usage:{completion_tokens:4}};
      res.end(body.stream ? `data: ${JSON.stringify(json)}\n\ndata: [DONE]\n\n` : JSON.stringify(json));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const model = {provider:'fixture',id:'empty',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}`};
    const readJsonFile = f => f === 'auth' ? {fixture:{key:'test'}} : {fixture:{models:[model]}};
    initDshKeys({authPath:'auth',modelsPath:'models',readJsonFile});
    initUnifiedChat({authPath:'auth',modelsPath:'models',readJsonFile,getModelList:()=>[model],
      UNIFIED_TOOLS:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}],
      executeUnifiedTool:async()=>{ executed++; return {text:'42'}; }});
    try {
      const result = await unifiedChat(model, [{role:'user',content:'查询'}], {
        maxTurns:3, executionContext:{onEvent:(type,data)=>diagnostics.push({type,data})},
      });
      assert.equal(requests.length, makesProgress ? 6 : 3);
      assert.equal(executed, makesProgress ? 1 : 0);
      assert.deepEqual(requests.map(r=>r.stream), makesProgress ? [true,false,false,true,false,false] : [true,false,false]);
      if (makesProgress) {
        assert.equal(result.text, '完成');
        assert.deepEqual(diagnostics.map(e=>e.data.attempt), [1,2,1,2]);
      } else {
        assert.equal(result.empty, true);
        assert.equal(result.emptyDiagnostic.attempt, 3);
        assert.equal(result.emptyDiagnostic.transport, 'json');
        assert.equal(result.emptyDiagnostic.completionTokens, 4);
        assert.equal(result.text, null, '思考内容不冒充正文');
      }
    } finally { await new Promise(resolve=>server.close(resolve)); }
  });
}
