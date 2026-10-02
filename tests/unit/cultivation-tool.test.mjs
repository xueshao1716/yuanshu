import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {controlFixture,draft} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';

test('mother tool requires live opaque identity and cannot perform human actions',async t=>{
  const url=new URL('../../engine/cultivation/tool.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'cultivation tool is implemented');
  const {cultivationTool}=await import(url),f=await controlFixture(t);
  const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{
    resolveMother:s=>s===f.mother&&s.active?{actorId:'fixture-mother',originId:'fixture-run'}:null}});
  const ctx={executionIdentity:f.mother};
  assert.equal((await cultivationTool(runtime,{action:'overview'},{})).isError,true);
  assert.equal((await cultivationTool(runtime,{action:'overview'},ctx)).isError,false);
  const command=f.command('design.submit',{design:draft()});
  const result=await cultivationTool(runtime,command,ctx);
  assert.equal(result.isError,false);assert.ok(JSON.parse(result.text).result.id);
  assert.equal((await cultivationTool(runtime,{...command,source:f.mother},ctx)).isError,true);
  assert.equal((await cultivationTool(runtime,{...command,action:'policy.set'},ctx)).isError,true);
  assert.equal((await cultivationTool(runtime,{action:'overview'},{executionIdentity:{...f.mother}})).isError,true);
  f.mother.active=false;
  assert.equal((await cultivationTool(runtime,{action:'overview'},ctx)).isError,true);
});

test('both chat engines preserve opaque cultivation identity without adding it to model arguments',()=>{
  const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8');
  const server=read('server.mjs'),session=read('engine/session-manager.mjs'),unified=read('engine/unified-chat.mjs');
  assert.ok(server.includes('CULTIVATION_TOOL_SCHEMA,'));
  assert.ok(server.includes('cultivation: (args, ctx) => cultivationTool(cultivationRuntime, args, ctx)'));
  assert.ok(server.includes('initCultivationTool('));
  assert.ok(session.includes('customTools.push(cultivationToolFactory('));
  assert.ok(session.split('\n').find(l=>l.includes('const FIRST_TURN_EXTRA')).includes('"cultivation"'));
  const contexts=unified.split('\n').filter(l=>l.includes('executionContext: { runId: runContext?.runId'));
  assert.equal(contexts.length,3);
  assert.ok(contexts.every(l=>l.includes('executionIdentity: runContext?.executionIdentity')));
  assert.ok(unified.includes("const cultivationSchema = _unifiedTools.find(t => t.function?.name === 'cultivation')"));
});

test('Pi chat carries the live identity across its non-enumerable tool context boundary',()=>{
  const server=fs.readFileSync(new URL('../../server.mjs',import.meta.url),'utf8');
  const contextAt=server.indexOf('const chatRunContext =');
  const contextEnd=server.indexOf('const refreshCultivationContext =',contextAt);
  const chatContext=server.slice(contextAt,contextEnd);
  assert.ok(chatContext.includes("Object.defineProperty(chatRunContext, 'executionIdentity'"));
  assert.ok(chatContext.includes('value: body.__runContext?.executionIdentity'));
  assert.ok(chatContext.includes('enumerable: false'));
  const at=server.indexOf('const piTeamToolContext =');
  assert.ok(at>0,'Pi context must be constructed before the agent prompt');
  const block=server.slice(at,server.indexOf('await withTeamToolContext(piTeamToolContext',at));
  assert.ok(block.includes("Object.defineProperty(piTeamToolContext, 'executionIdentity'"));
  assert.ok(block.includes('value: body.__runContext?.executionIdentity'));
  assert.ok(block.includes('enumerable: false'));
  assert.ok(block.includes('configurable: false'));
  assert.ok(block.includes('writable: false'));
  assert.ok(!block.includes('JSON.stringify'));
});

test('scheduler passes opaque identity only to executor, never event callbacks or results',async()=>{
  const {scheduleToolCalls}=await import('../../engine/tool-scheduler.mjs');
  const identity=Object.freeze({}),events=[];let received;
  const results=await scheduleToolCalls({toolCalls:[{id:'t',function:{name:'cultivation',arguments:'{"action":"overview"}'}}],
    executionContext:{executionIdentity:identity},onTool:(...args)=>events.push(args.at(-1)),
    onToolEnd:(...args)=>events.push(args.at(-1)),tools:{execute:async(_name,_args,ctx)=>{received=ctx.executionIdentity;return {text:'ok'};}}});
  assert.equal(received,identity);
  assert.ok(events.every(ctx=>!Object.hasOwn(ctx,'executionIdentity')));
  assert.ok(!JSON.stringify(results).includes('executionIdentity'));
});

test('tool explains revocable prior mother learning authority without claiming personality powers',async()=>{
  const {CULTIVATION_TOOL_SCHEMA}=await import('../../engine/cultivation/tool.mjs');
  const text=CULTIVATION_TOOL_SCHEMA.function.description;
  for(const word of ['motherLearning','mother','独立来源','撤销','人格','控制版本'])assert.ok(text.includes(word),word);
  assert.ok(!text.includes('向母体共享另需用户签名'));
});

test('design schema makes string curricula explicit for both engine adapters', async () => {
  const {CULTIVATION_TOOL_SCHEMA, createPiCultivationTool} = await import('../../engine/cultivation/tool.mjs');
  const schema = CULTIVATION_TOOL_SCHEMA.function.parameters;
  const design = schema.properties.payload.properties?.design;
  assert.ok(design, 'design structure must be visible to the model');
  assert.equal(design.additionalProperties, false);
  for (const field of Object.keys(draft())) assert.ok(design.required.includes(field), field);
  for (const field of ['curriculum', 'goals']) {
    assert.equal(design.properties[field].type, 'array');
    assert.equal(design.properties[field].items.type, 'string');
    assert.equal(design.properties[field].minItems, 1);
  }
  assert.ok(design.properties.curriculum.description.includes('过关标准'));
  // Only adapt the schema constructor; the production tool must share its complete contract.
  const pi = createPiCultivationTool({Unsafe: value => value}, () => null);
  assert.deepEqual(pi.parameters, schema);
});

test('mother can repair a rejected staged curriculum and persist all stages without enabling policy', async t => {
  const {cultivationTool} = await import('../../engine/cultivation/tool.mjs'), f = await controlFixture(t);
  const runtime = createCultivationRuntime({wsRoot: f.root, identityAdapters: {
    resolveMother: s => s === f.mother && s.active ? {actorId:'fixture-mother',originId:'fixture-run'} : null}});
  const ctx = {executionIdentity:f.mother}, d = draft();
  d.curriculum = [1, 2, 3, 4, 5].map(stage => ({stage, title:`private-stage-${stage}`, content:'Read evidence', pass_criterion:'Check every claim'}));
  const before = f.store.read('control');
  const rejected = await cultivationTool(runtime, f.command('design.submit', {design:d}), ctx);
  assert.equal(rejected.isError, true);
  const details = JSON.parse(rejected.text);
  assert.equal(details.error, 'cultivation_invalid_design');
  assert.equal(details.field, 'design.curriculum[0]');
  assert.ok(details.expected.includes('字符串'));
  assert.ok(details.expected.includes('过关标准'));
  assert.ok(!rejected.text.includes('private-stage'));
  assert.deepEqual(f.store.read('control'), before, 'invalid design must not change revision, receipts or drafts');
  d.curriculum = d.curriculum.map(s => `阶段 ${s.stage}：${s.title}；内容：${s.content}；过关标准：${s.pass_criterion}`);
  const accepted = await cultivationTool(runtime, f.command('design.submit', {design:d}), ctx);
  assert.equal(accepted.isError, false, accepted.text);
  const receipt = JSON.parse(accepted.text), after = f.store.read('control');
  assert.equal(after.revision, 1);
  assert.deepEqual(after.data.designs[0].design, d);
  assert.equal(after.data.policy.enabled, false);
  const register = await cultivationTool(runtime, f.command('agent.register', {designId:receipt.result.id}), ctx);
  const blocked = JSON.parse(register.text);
  assert.equal(blocked.error, 'cultivation_policy_disabled');
  assert.equal(blocked.retryable, false);
  assert.ok(blocked.nextAction.includes('授权与资源'));
  assert.ok(blocked.nextAction.includes('会话确认'));
  assert.deepEqual(f.store.read('control'), after, 'draft acceptance must not bypass adoption policy');
});

test('policy and permission failures explain recovery without inviting unchanged retries or tool expansion', async () => {
  const {cultivationTool}=await import('../../engine/cultivation/tool.mjs');
  for(const code of ['cultivation_policy_expired','cultivation_permission_expansion','cultivation_request_denied']) {
    const result=await cultivationTool({execute:async()=>{throw new Error(code);}}, {action:'design.revise'}, {executionIdentity:{}});
    assert.equal(result.isError,true);
    const info=JSON.parse(result.text);
    assert.equal(info.error,code);assert.equal(info.retryable,false);
    assert.ok(info.nextAction.includes('不要重复'));
    if(code==='cultivation_permission_expansion') {
      assert.ok(info.nextAction.includes('tools=[]'));
      assert.ok(info.nextAction.includes('remote'));
    }
  }
});

test('tool does not expose arbitrary exception fields or messages as validation diagnostics', async () => {
  const {cultivationTool} = await import('../../engine/cultivation/tool.mjs');
  const runtime = {execute: async () => {throw Object.assign(new Error('cultivation_invalid_design'), {field:'private-path',expected:'private-secret'});}};
  const result = await cultivationTool(runtime, {action:'design.submit'}, {executionIdentity:{}});
  assert.equal(result.text, 'cultivation_invalid_design');
});
