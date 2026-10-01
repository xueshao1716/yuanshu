import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {knowledgeChatContext} from '../../engine/knowledge-chat.mjs';
const mod=await import('../../engine/knowledge-chat-request.mjs').catch(()=>({}));

test('request lifecycle cancels knowledge lookup without leaking listeners',async()=>{
  assert.equal(typeof mod.withKnowledgeRequest,'function');
  for(const synthetic of [false,true]){
    const req=new EventEmitter(),res=new EventEmitter();
    if(!synthetic)req.complete=true;
    let started;const ready=new Promise(r=>{started=r;});
    const pending=mod.withKnowledgeRequest(req,res,signal=>knowledgeChatContext({context:()=>{
      started();return new Promise(()=>{});
    }},{signal,timeoutMs:50},()=>assert.fail('explicit stop must be quiet')));
    await ready;
    if(synthetic){req.destroyed=true;req.emit('close');}else{res.destroyed=true;res.emit('close');}
    assert.equal(await pending,'');assert.equal(mod.knowledgeRequestStopped(req,res),true);
    for(const obj of [req,res])assert.equal(obj.eventNames().length,0);
  }
});

test('a fully received HTTP body does not cancel a still-open response',async()=>{
  assert.equal(typeof mod.withKnowledgeRequest,'function');
  const req=new EventEmitter(),res=new EventEmitter();req.complete=true;req.destroyed=true;
  assert.equal(await mod.withKnowledgeRequest(req,res,async signal=>{
    req.emit('close');assert.equal(signal.aborted,false);return 'context';
  }),'context');
  assert.equal(req.eventNames().length,0);assert.equal(res.eventNames().length,0);
});

test('server binds both context sources to the request and stops before model execution',()=>{
  const source=fs.readFileSync('server.mjs','utf8');
  assert.equal(source.split('withKnowledgeRequest(req, res, signal =>').length-1,2);
  assert.equal(source.split('if (knowledgeRequestStopped(req, res)) return res.end();').length-1,4);
});
