import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../../engine/knowledge-chat.mjs').catch(()=>({}));
test('knowledge failure is visible but never rejects the chat',async()=>{
 assert.equal(typeof mod.knowledgeChatContext,'function');
 // 2026-10-11 通知收窄：真故障（knowledge_unavailable）可见；任务轮本不检索（origin_excluded）与
 // 用户中断（aborted）不算故障，不再出"暂不可用"卡
 for(const [context,expect] of [
   [async()=>({available:false,reason:'knowledge_unavailable',context:''}),1],
   [async()=>({available:false,reason:'origin_excluded',context:''}),0],
   [async()=>({available:false,reason:'aborted',context:''}),0],
   [async()=>{throw Error('private path');},1],
 ]){
  const notes=[];assert.equal(await mod.knowledgeChatContext({context},{},text=>notes.push(text)),'');
  assert.equal(notes.length,expect);
  if(expect)assert.ok(!notes[0].includes('private'));
 }
});
test('native context injection rejection cannot stop chat',async()=>{
 assert.equal(typeof mod.deliverKnowledgeContext,'function');const notes=[];
 await mod.deliverKnowledgeContext({sendCustomMessage:async()=>{throw Error('unavailable');}},'reference',t=>notes.push(t));
 assert.equal(notes.length,1);
});
