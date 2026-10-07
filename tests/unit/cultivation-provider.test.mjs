import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function fixture(){
  const url=new URL('../../engine/cultivation/provider.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'bounded text provider exists');
  const {createCultivationProvider}=await import(url);
  let calls=0,actual,args;
  const model={provider:'fixture',id:'text',enabled:true};
  const provider=createCultivationProvider({catalog:()=>[model],directChat:async(...v)=>{
    calls++;args=v;return actual??{text:'A synthetic result',usedModel:model,usage:{input_tokens:10,output_tokens:20}};
  }});
  const input={run:{request:{message:'Untrusted explicit input'},cultivation:{goal:'A test',criterion:'Bounded'}},
    design:{name:'Synthetic child',temporaryExpression:'curious',permissions:{model:'fixture/text',remote:true}},
    policy:{allowRemote:true,timeoutMs:1000},sharedPolicy:{allowedModels:['fixture/text'],inputTokens:4096,outputTokens:256,
      currency:'USD',rates:{'fixture/text':{input:1,output:2,currency:'USD',tokenBound:'utf8-bytes'}}}};
  return {provider,input,calls:()=>calls,args:()=>args,result:v=>{actual=v;}};
}
test('provider prepares a conservative upper bound and sends no inherited context or tools',async()=>{
  const f=await fixture(),plan=await f.provider.prepare(f.input);
  assert.equal(f.calls(),0);assert.ok(plan.maxCost>0);assert.equal(plan.remote,true);
  const result=await f.provider.invoke({...f.input,plan,signal:new AbortController().signal});
  assert.equal(result.text,'A synthetic result');assert.equal(result.usage.cost,0.00005);
  const args=f.args();assert.deepEqual(args[2],[]);assert.equal(args[3].allowEndpointFallback,false);
  assert.equal(args[3].allowPartial,false);assert.equal(args[3].maxTokens,256);
  assert.equal(JSON.parse(args[1]).input,'Untrusted explicit input');
});
test('provider refuses unknown prices, unbounded inputs, local claims and model substitution',async()=>{
  const f=await fixture();
  await assert.rejects(f.provider.prepare({...f.input,sharedPolicy:{...f.input.sharedPolicy,rates:{}}}),/price_unknown/);
  await assert.rejects(f.provider.prepare({...f.input,sharedPolicy:{...f.input.sharedPolicy,inputTokens:1}}),/input_limit/);
  await assert.rejects(f.provider.prepare({...f.input,design:{...f.input.design,permissions:{...f.input.design.permissions,remote:false}}}),/remote_required/);
  const plan=await f.provider.prepare(f.input);f.result({text:'Result',usedModel:{provider:'other',id:'text'}});
  await assert.rejects(f.provider.invoke({...f.input,plan}),/model_changed/);
  assert.equal(f.calls(),1);
});

test('provider includes only bounded approved learning and rejects changed learning before dispatch',async()=>{
  const f=await fixture();let current='evidence-v1';
  const {createCultivationProvider}=await import('../../engine/cultivation/provider.mjs');
  let calls=0;
  const provider=createCultivationProvider({catalog:()=>[{provider:'fixture',id:'text'}],directChat:()=>{calls++;},
    learning:{context:async({scope})=>{assert.equal(scope,'child-id');return {context:current,entries:[]};}}});
  f.input.run.cultivation.agentId='child-id';
  f.input.policy.dataScopes=['knowledge:approved-cultivation'];
  f.input.design.permissions.dataScopes=['knowledge:approved-cultivation'];
  const plan=await provider.prepare(f.input);current='evidence-v2';
  await assert.rejects(provider.invoke({plan}),/learning_changed/);assert.equal(calls,0);
});

test('provider does not retrieve or send learning without explicit policy AND design data permission',async()=>{
  const f=await fixture();let reads=0,sent;
  const {createCultivationProvider}=await import('../../engine/cultivation/provider.mjs');
  const provider=createCultivationProvider({catalog:()=>[{provider:'fixture',id:'text'}],
    learning:{context:async()=>{reads++;return {context:'SYNTHETIC_PRIVATE_SOURCE',entries:[]};}},
    directChat:async(_model,message)=>{sent=JSON.parse(message);return {text:'ok',usedModel:{provider:'fixture',id:'text'}};}});
  for(const [policyScopes,designScopes] of [[[],[]],[['knowledge:approved-cultivation'],[]],[[],['knowledge:approved-cultivation']]]){
    const input={...f.input,policy:{...f.input.policy,dataScopes:policyScopes},
      design:{...f.input.design,permissions:{...f.input.design.permissions,dataScopes:designScopes}}};
    const plan=await provider.prepare(input);await provider.invoke({plan});
    assert.equal(sent.approvedReferences,'');
  }
  assert.equal(reads,0);
});

// 2026-10-07 真机：持衡首份作业，step-5-preview 推理把 1200 输出额度吃光，正文为空、被记成「结果未知」。
test('reasoning model needs enough output tokens and timeout; refused before dispatch',async()=>{
  const {createCultivationProvider,reasoningShortfall}=await import('../../engine/cultivation/provider.mjs');
  const model={provider:'fixture',id:'text',reasoning:true};let calls=0;
  const provider=createCultivationProvider({catalog:()=>[model],directChat:async()=>{calls++;return {text:'ok',usedModel:model};}});
  const f=await fixture();
  await assert.rejects(provider.prepare({...f.input,sharedPolicy:{...f.input.sharedPolicy,outputTokens:1200,inputTokens:8000}}),/reasoning_budget/);
  await assert.rejects(provider.prepare({...f.input,policy:{...f.input.policy,timeoutMs:60000},sharedPolicy:{...f.input.sharedPolicy,outputTokens:4096,inputTokens:8000}}),/reasoning_budget/);
  await provider.prepare({...f.input,policy:{...f.input.policy,timeoutMs:180000},sharedPolicy:{...f.input.sharedPolicy,outputTokens:4096,inputTokens:8000}});
  assert.equal(calls,0);
  assert.equal(reasoningShortfall({reasoning:false},{outputTokens:10,timeoutMs:1000}),null,'non-reasoning models keep old limits');
});
test('truncated reply with usage is a definite failure carrying usage, not an unknown outcome',async()=>{
  const f=await fixture(),plan=await f.provider.prepare(f.input);
  f.result({text:null,truncated:true,usedModel:{provider:'fixture',id:'text'},usage:{prompt_tokens:10,completion_tokens:256}});
  await assert.rejects(f.provider.invoke({...f.input,plan}),e=>e.message==='cultivation_output_truncated'&&e.definite===true&&e.usage.cost>0);
  const plan2=await f.provider.prepare(f.input);
  f.result({text:null,truncated:true,usedModel:{provider:'fixture',id:'text'}});
  await assert.rejects(f.provider.invoke({...f.input,plan:plan2}),e=>e.message==='cultivation_provider_format'&&!e.definite,'no usage → stays unknown');
});
