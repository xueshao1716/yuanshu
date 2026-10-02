import test from 'node:test';
import assert from 'node:assert/strict';
import {extractLocal,validateCandidate} from '../../engine/knowledge-evidence.mjs';
import {createKnowledgeRetrieval} from '../../engine/knowledge-retrieval.mjs';
import {createKnowledgeMaintenance} from '../../engine/knowledge-maintenance.mjs';
import {digest} from '../../engine/knowledge-state.mjs';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';

const source=text=>({id:'s',kind:'run_result',authority:'model_output',text,hash:digest(text),
  locator:'run:r/result',fetchedAt:100,reference:{kind:'run',sessionId:'current',runId:'r'}});
const job={event:'completed',sessionId:'current',sourceVersion:'version'};
test('progress-only model chatter is skipped but technical material and user statements are retained',()=>{
  const chatter=source('好嘞，已经安排上了——图正在后台生成中，出来会直接显示在这里，你稍等片刻就行 😊');
  assert.equal(extractLocal([chatter],job),null);
  const forced={kind:'source',text:chatter.text,sourceId:'s',sourceHash:chatter.hash,offset:0};
  assert.equal(validateCandidate({candidate:forced,snapshots:[chatter],job}).reason,'low_quality_model_output');
  const useful=source('图正在后台生成中，但失败原因是模型返回 403。已验证分组无权限，切换模型前应核对账号分组。');
  assert.ok(extractLocal([useful],job));
  assert.ok(extractLocal([{...chatter,authority:'user_statement'}],job));
});
test('automatic retrieval suppresses same-session model echo and legacy chatter; explicit inspection keeps provenance',async()=>{
  const model=source('服务端口为8787，尚需独立验证。'),user={...source('我需要服务端口可配置。'),authority:'user_statement'};
  const make=(s,id)=>({id,text:s.text,kind:'source',status:'active',verified:false,sessionId:'current',expiresAt:10000,
    scope:'仅来源陈述',sources:[{...s,text:undefined,offset:0,length:s.text.length}]});
  const entries=[make(model,'model'),make(user,'user'),make(source('服务端口正在后台处理中，请稍等。'),'chatter')];
  const r=createKnowledgeRetrieval({store:{entries:async()=>entries,policy:async()=>({revision:1}),retrievalCurrent:()=>true},verifySource:async()=>true,now:()=>200});
  await r.refresh();
  assert.deepEqual((await r.retrieve({query:'服务端口',sessionId:'current',requireRelevant:true})).entries.map(e=>e.id),['user']);
  const explicit=await r.retrieve({query:'',sessionId:'current',entryIds:['model']});
  assert.equal(explicit.entries.length,1);assert.match(explicit.context,/model_output/);assert.match(explicit.context,/fetchedAt/);
  assert.ok(Buffer.byteLength(explicit.context)<=2000);
  assert.equal((await r.retrieve({query:'服务端口',sessionId:'current',entryIds:['model'],requireRelevant:true})).entries.length,0);
});
test('expired unverified model output is retired without renewing the identical run as fresh evidence',async t=>{
  const f=await controlFixture(t),s=source('服务状态为等待设计稿，尚无个体。');let collected=0,enqueued=0;
  const retired=[];
  const maintenance=createKnowledgeMaintenance({wsRoot:f.root,now:()=>200,budget:{status:async()=>({day:'2026-10-02'})},
    collect:async()=>{collected++;return [s];},store:{policy:async()=>({localEnabled:true,paused:false}),
      entries:async()=>[{id:'entry',jobId:'job',kind:'source',status:'active',expiresAt:100,verified:false,sources:[s]}],
      invalidateEntry:async(...args)=>retired.push(args),enqueue:async()=>{enqueued++;return {id:'new'};}}});
  await maintenance.reconcile();assert.deepEqual(retired,[['entry','expired']]);assert.equal(collected,0);assert.equal(enqueued,0);
});
