import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {hostFixture} from '../helpers/cultivation-host-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
const mod=await import('../../engine/cultivation/chat.mjs').catch(()=>({}));
const id='a'.repeat(64);
const input=()=>({executionIdentity:{},query:'网络',sessionId:'s',runId:'r'});

test('chat requests bounded mother-scoped evidence and only records offered references',async()=>{
 assert.equal(typeof mod.cultivationChatContext,'function');
 const i=input(),calls=[],offers=[];
 const runtime={async readMother(command,source){calls.push({command,source});return {available:true,entries:[{id}],context:'untrusted reference'};}};
 const knowledge={offerCultivationReferences:(scope,ids)=>offers.push({scope,ids})};
 const result=await mod.cultivationChatContext(runtime,knowledge,{...i,query:'网'.repeat(1100)});
 assert.equal(result,'untrusted reference');assert.equal(calls[0].source,i.executionIdentity);
 assert.equal(calls[0].command.action,'learning.context');assert.equal(calls[0].command.payload.query.length,1000);
 assert.deepEqual(offers,[{scope:{runId:'r',sessionId:'s'},ids:[id]}]);
});

test('absent, fake and revoked host identities cannot supply chat knowledge',async t=>{
 assert.equal(typeof mod.cultivationChatContext,'function');
 const f=await hostFixture(t);f.adapter.bind(f.source,f.binding);
 const runtime=createCultivationRuntime({wsRoot:f.root,identityAdapters:{resolveMother:f.adapter.resolveMother},
  learning:{context:()=>assert.fail('disabled policy must not retrieve')}});
 const notes=[],offers=[],knowledge={offerCultivationReferences:(_scope,ids)=>offers.push(ids)};
 for(const executionIdentity of [undefined,{...f.source},f.source]){
  assert.equal(await mod.cultivationChatContext(runtime,knowledge,{...input(),executionIdentity},n=>notes.push(n)),'');
 }
 f.entry.gen++;
 assert.equal(await mod.cultivationChatContext(runtime,knowledge,{...input(),executionIdentity:f.source},n=>notes.push(n)),'');
 assert.equal(notes.length,0);assert.ok(offers.every(ids=>ids.length===0));
});

test('learning failure is bounded and private errors do not stop text chat or leave stale offers',async()=>{
 assert.equal(typeof mod.cultivationChatContext,'function');
 for(const readMother of [async()=>{throw Error('private-token-path');},async()=>({available:false,entries:[],context:''})]){
  const notes=[],offers=[];
  assert.equal(await mod.cultivationChatContext({readMother},{offerCultivationReferences:(_scope,ids)=>offers.push(ids)},input(),n=>notes.push(n)),'');
  assert.equal(notes.length,1);assert.ok(!notes[0].includes('private'));assert.deepEqual(offers,[[]]);
 }
});

test('host refreshes cultivation context on both text paths and again before fallback',()=>{
 const server=fs.readFileSync('server.mjs','utf8');
 assert.ok(server.includes('cultivationChatContext(cultivationRuntime, knowledgeRuntime'));
 assert.equal(server.split('await refreshCultivationContext();').length-1,3);
 const unified=server.indexOf('await handleUnifiedChat(res, entry, message');
 assert.ok(server.lastIndexOf('await refreshCultivationContext();',unified)>server.lastIndexOf('} else {',unified));
 const native=server.indexOf('await deliverKnowledgeContext(entry.agent');
 assert.ok(server.slice(native-100,native).includes('await refreshCultivationContext();'));
 const fallback=server.indexOf('const abortCtrl2 = new AbortController();');
 assert.ok(server.slice(fallback-450,fallback).includes('await refreshCultivationContext();'));
});
