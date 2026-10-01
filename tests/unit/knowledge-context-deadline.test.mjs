import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import {knowledgeChatContext} from '../../engine/knowledge-chat.mjs';
import {cultivationChatContext} from '../../engine/cultivation/chat.mjs';
import {createKnowledgeRetrieval} from '../../engine/knowledge-retrieval.mjs';

test('synchronous abort and throw do not leave an unhandled rejection',()=>{
  const moduleUrl=new URL('../../engine/knowledge-context-deadline.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {boundedKnowledgeContext} from ${JSON.stringify(moduleUrl)};
    const controller=new AbortController();
    await assert.rejects(boundedKnowledgeContext(()=>{
      controller.abort();throw new Error('lookup failed');
    },{signal:controller.signal}));
    await new Promise(resolve=>setImmediate(resolve));
  `],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.stderr);
});

for(const kind of ['knowledge','cultivation']){
  function fixture(read){
    const offers=[],notes=[],input={runId:'r',sessionId:'s',executionIdentity:{},timeoutMs:15};
    const invoke=kind==='knowledge'
      ?i=>knowledgeChatContext({context:read},i,n=>notes.push(n))
      :i=>cultivationChatContext({readMother:(_c,_i,options={})=>read(options)},
        {offerCultivationReferences:(_scope,ids)=>offers.push(ids)},i,n=>notes.push(n));
    return {offers,notes,input,invoke};
  }
  test(`${kind} context abandons a stalled lookup and discards its late result`,async()=>{
    let release,seen;
    const f=fixture(input=>{seen=input.signal;return new Promise(r=>{release=r;});});
    const pending=f.invoke(f.input);
    try{
      assert.equal(await Promise.race([pending,delay(150).then(()=> 'STALLED')]),'');
      assert.equal(seen.aborted,true);assert.equal(f.notes.length,1);
      release({available:true,entries:[{id:'a'.repeat(64)}],context:'late reference'});
      await delay(0);assert.ok(f.offers.every(ids=>ids.length===0));
    }finally{release?.({available:true,entries:[],context:''});await pending;}
  });
  test(`${kind} context cancels quietly before and during lookup`,async()=>{
    for(const alreadyAborted of [true,false]){
      const controller=new AbortController();let calls=0,signal;
      if(alreadyAborted)controller.abort();
      const f=fixture(input=>{calls++;signal=input.signal;return new Promise(()=>{});});
      const pending=f.invoke({...f.input,signal:controller.signal});
      if(!alreadyAborted)controller.abort();
      assert.equal(await Promise.race([pending,delay(150).then(()=> 'STALLED')]),'');
      assert.equal(calls,alreadyAborted?0:1);assert.equal(f.notes.length,0);
      if(signal)assert.equal(signal.aborted,true);
    }
  });
  test(`${kind} successful lookup releases its cancellation listener`,async()=>{
    let seen;const f=fixture(async input=>{seen=input.signal;return {available:true,entries:[],context:'reference'};});
    const controller=new AbortController();
    assert.equal(await f.invoke({...f.input,signal:controller.signal}),'reference');
    controller.abort();await delay(25);
    assert.equal(seen?.aborted,false);assert.deepEqual(f.notes,[]);
  });
}

test('cancelled retrieval discards verified data and does not inspect the next source',async()=>{
  const controller=new AbortController();let calls=0;
  const entry=id=>({id,text:'network',kind:'source',status:'active',expiresAt:1000,
    sources:[{locator:'docs/test.txt',hash:'x',reference:{kind:'file'}}]});
  const retrieval=createKnowledgeRetrieval({now:()=>0,
    store:{entries:async()=>[entry('a'),entry('b')],policy:async()=>({revision:1}),retrievalCurrent:()=>true},
    verifySource:async()=>{calls++;controller.abort();return true;}});
  await retrieval.refresh();
  const result=await retrieval.retrieve({query:'network',signal:controller.signal});
  assert.equal(calls,1);assert.equal(result.available,false);assert.deepEqual(result.entries,[]);assert.equal(result.context,'');
});
