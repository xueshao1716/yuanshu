import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeProvider} from '../../engine/knowledge-provider.mjs';
import {defaultKnowledgePolicy} from '../../engine/knowledge-policy.mjs';
const model={provider:'fixture',id:'text',api:'openai-completions',capabilities:['text'],enabled:true};
const policy=()=>({...defaultKnowledgePolicy(),remoteEnabled:true,model:'fixture/text',allowedModels:['fixture/text'],outboundRoots:['docs'],rates:{'fixture/text':{input:1,output:2,currency:'USD',tokenBound:'utf8-bytes'}}});
const snapshots=[{kind:'file',locator:'docs/a.txt',text:'真实原文',hash:'hash',id:'source',reference:{path:'docs/a.txt'}}];
function setup(fn){let calls=0,reserves=0,settles=[];return {provider:createKnowledgeProvider({wsRoot:process.cwd(),catalog:()=>[model],
  budget:{reserve:async args=>{reserves++;return {id:'r',...args};},settle:async(...args)=>settles.push(args)},
  directChat:async(...args)=>{calls++;return fn(...args);}}),stats:()=>({calls,reserves,settles})};}
test('provider never calls disabled, unpriced, unauthorized or overlarge sources',async()=>{
  const {provider,stats}=setup(()=>{throw Error('must not call');});
  await assert.rejects(provider.extract({snapshots,policy:{...policy(),remoteEnabled:false}}),{code:'remote_disabled'});
  await assert.rejects(provider.extract({snapshots,policy:{...policy(),rates:{}}}),{code:'price_unknown'});
  await assert.rejects(provider.extract({snapshots,policy:{...policy(),outboundRoots:[]}}),{code:'outbound_denied'});
  await assert.rejects(provider.extract({snapshots,policy:{...policy(),inputTokens:1}}),{code:'input_limit'});
  assert.equal(stats().calls,0);assert.equal(stats().reserves,0);
});
test('provider caps a single selected request and preserves unknown usage',async()=>{
  const {provider,stats}=setup((m,message,history,opts)=>{
    assert.equal(m.id,'text');assert.equal(opts.allowEndpointFallback,false);assert.equal(opts.timeout,60000);
    assert.equal(opts.maxTokens,1200);assert.equal(opts.thinking,false);
    return {text:JSON.stringify({kind:'synthesis',text:'归纳'}),usedModel:{provider:'fixture',id:'text'}};
  });
  const result=await provider.extract({snapshots,policy:policy(),signal:new AbortController().signal});
  assert.equal(result.kind,'synthesis');assert.equal(stats().reserves,1);assert.equal(stats().settles[0][1],null);
});
test('provider refuses model replacement and sanitizes failure details',async()=>{
  const a=setup(()=>({text:'{}',usedModel:{provider:'other',id:'expensive'}}));
  await assert.rejects(a.provider.extract({snapshots,policy:policy()}),{code:'model_changed'});
  const b=setup(()=>{throw Error('HTTP 402 secret-token');});
  await assert.rejects(b.provider.extract({snapshots,policy:policy()}),e=>e.code==='provider_payment'&&!e.message.includes('secret'));
  assert.equal(b.stats().settles[0][1],null);
});
test('provider sends only a focused bounded exact excerpt with its full source hash and absolute offset',async()=>{
 const text='无关资料'.repeat(550)+'目标规则：需要验证实际产物。'+'其他资料'.repeat(200);
 let sent;const {provider,stats}=setup((m,message,history,opts)=>{
  sent=JSON.parse(message);const piece=sent[0];
  assert.ok(piece.text.includes('目标规则'));assert.ok(piece.text.length<text.length);
  assert.equal(piece.hash,'full-hash');assert.equal(text.slice(piece.offset,piece.offset+piece.length),piece.text);
  assert.ok(Buffer.byteLength(JSON.stringify([{role:'system',content:opts.systemHint},{role:'user',content:message}]))+256<=6000);
  return {text:JSON.stringify({kind:'source',text:piece.text,sourceId:piece.id,sourceHash:piece.hash,offset:piece.offset}),usedModel:model};
 });
 const result=await provider.extract({snapshots:[{...snapshots[0],text,hash:'full-hash'}],job:{focus:'目标规则'},policy:policy()});
 assert.equal(stats().calls,1);assert.equal(result.offset,sent[0].offset);
});
test('focused later sources are not squeezed out by unrelated earlier material',async()=>{
 const {provider}=setup((m,message)=>{
  const pieces=JSON.parse(message);assert.equal(pieces[0].id,'relevant');assert.ok(pieces[0].text.includes('目标规则'));
  return {text:JSON.stringify({kind:'synthesis',text:'归纳'}),usedModel:model};
 });
 await provider.extract({snapshots:[{...snapshots[0],text:'无关资料'.repeat(500)},
  {...snapshots[0],id:'relevant',locator:'docs/relevant.txt',text:'目标规则：必须验证。'.repeat(300)}],job:{focus:'目标规则'},policy:{...policy(),inputTokens:1800}});
});
test('provider rejects a fabricated excerpt outside the transmitted original-source slice',async()=>{
 const text='无关资料'.repeat(500)+'目标规则：必须验证。';
 const {provider}=setup(()=>({text:JSON.stringify({kind:'source',text:'无关资料',sourceId:'source',sourceHash:'hash',offset:0}),usedModel:model}));
 await assert.rejects(provider.extract({snapshots:[{...snapshots[0],text}],job:{focus:'目标规则'},policy:policy()}),{code:'excerpt_mismatch'});
});
