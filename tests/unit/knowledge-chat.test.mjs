import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../../engine/knowledge-chat.mjs').catch(()=>({}));
test('knowledge failure is visible but never rejects the chat',async()=>{
 assert.equal(typeof mod.knowledgeChatContext,'function');
 for(const context of [async()=>({available:false,context:''}),async()=>{throw Error('private path');}]){
  const notes=[];assert.equal(await mod.knowledgeChatContext({context},{},text=>notes.push(text)),'');
  assert.equal(notes.length,1);assert.ok(!notes[0].includes('private'));
 }
});
test('native context injection rejection cannot stop chat',async()=>{
 assert.equal(typeof mod.deliverKnowledgeContext,'function');const notes=[];
 await mod.deliverKnowledgeContext({sendCustomMessage:async()=>{throw Error('unavailable');}},'reference',t=>notes.push(t));
 assert.equal(notes.length,1);
});
