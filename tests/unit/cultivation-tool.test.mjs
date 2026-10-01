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
