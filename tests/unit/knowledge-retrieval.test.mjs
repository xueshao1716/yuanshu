import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeRetrieval} from '../../engine/knowledge-retrieval.mjs';
const entry=(extra={})=>({id:'e',text:'路由器网络配置经验',kind:'source',status:'active',expiresAt:10000,scope:'来源陈述',
 sources:[{locator:'docs/a.txt',reference:{kind:'file'},hash:'hash'}],...extra});
const currentStore=extra=>({policy:async()=>({revision:1}),retrievalCurrent:(_entries,revision)=>revision===1,...extra});
test('automatic exact-scope retrieval requires relevance while evidence inspection remains exact',async()=>{
 const r=createKnowledgeRetrieval({store:currentStore({entries:async()=>[entry()]}),verifySource:async()=>true,now:()=>100});
 await r.refresh();
 assert.equal((await r.retrieve({query:'服装设计',entryIds:['e'],requireRelevant:true})).entries.length,0);
 assert.equal((await r.retrieve({query:'',entryIds:['e'],requireRelevant:true})).entries.length,0);
 assert.equal((await r.retrieve({query:'网络',entryIds:['e'],requireRelevant:true})).entries.length,1);
 assert.equal((await r.retrieve({query:'',entryIds:['e']})).entries.length,1);
});
test('retrieval is cached, scoped, bounded and attributed; retrieval is not successful use',async()=>{
 let reads=0,uses=0;const rows=[entry(),entry({id:'private',sources:[{locator:'run:r',reference:{kind:'run',sessionId:'other'}}]}),entry({id:'expired',expiresAt:1}),entry({id:'pending',status:'conflict'})];
 const r=createKnowledgeRetrieval({store:currentStore({entries:async()=>{reads++;return rows;},recordUse:async()=>uses++}),verifySource:async()=>true,now:()=>100});
 await r.refresh();const out=await r.retrieve({query:'网络配置',sessionId:'current',runId:'task'});
 assert.equal(out.entries.length,1);assert.match(out.context,/docs\/a.txt/);assert.match(out.context,/不可信/);assert.equal(reads,1);assert.equal(uses,0);
 assert.equal((await r.retrieve({query:'完全无关',sessionId:'current'})).entries.length,0);
 assert.equal((await r.retrieve({query:'网络',maxTokens:1})).entries.length,0);
});
test('source revocation excludes cached entries and errors are visible without blocking chat',async()=>{
 const r=createKnowledgeRetrieval({store:currentStore({entries:async()=>[entry()]}),verifySource:async()=>false,now:()=>100});await r.refresh();
 assert.equal((await r.retrieve({query:'网络'})).entries.length,0);
 const broken=createKnowledgeRetrieval({store:{entries:async()=>{throw Error('private path');}},verifySource:async()=>true});
 await broken.refresh();assert.deepEqual(await broken.retrieve({query:'网络'}),{available:false,entries:[],context:'',reason:'knowledge_unavailable'});
});
test('long Chinese evidence is clipped around the query without losing original offsets or exceeding budget',async()=>{
 const text='前文资料'.repeat(220)+'网络配置需要先核查端口，再验证连通性。'+'后续资料'.repeat(100);
 const original=entry({id:'a'.repeat(64),text,sources:[{locator:'docs/long.txt',hash:'full-source-hash',offset:81,length:text.length}]});
 const r=createKnowledgeRetrieval({store:currentStore({entries:async()=>[original]}),verifySource:async()=>true,now:()=>100});await r.refresh();
 const result=await r.retrieve({query:'网络配置',maxTokens:2000});
 assert.equal(result.entries.length,1);assert.ok(Buffer.byteLength(result.context)<=2000);
 const clipped=result.entries[0];assert.ok(clipped.text.includes('网络配置'));assert.ok(clipped.text.length<text.length);
 assert.equal(clipped.sources[0].hash,'full-source-hash');assert.equal(clipped.sources[0].length,clipped.text.length);
 assert.equal(text.slice(clipped.sources[0].offset-81,clipped.sources[0].offset-81+clipped.sources[0].length),clipped.text);
 assert.ok(result.context.includes('"offset":'));assert.equal(original.text,text);
});
test('retrieval never verifies a source that cannot fit its outbound context budget',async()=>{
 let verified=0;const r=createKnowledgeRetrieval({store:currentStore({entries:async()=>[entry()]}),verifySource:async()=>{verified++;return true;},now:()=>100});
 await r.refresh();assert.equal((await r.retrieve({query:'网络',maxTokens:1})).entries.length,0);assert.equal(verified,0);
});
test('one retrieval shares current policy and rejects a revision changed during source verification',async()=>{
 let revision=1,reads=0;const seen=[];
 const r=createKnowledgeRetrieval({store:{entries:async()=>[entry(),entry({id:'e2'})],policy:async()=>{reads++;return {revision};},
 retrievalCurrent:(_entries,expected)=>{reads++;return revision===expected;}},
 verifySource:async(_entry,policy)=>{seen.push(policy?.revision);revision=2;return true;},now:()=>100});
 await r.refresh();const result=await r.retrieve({query:'网络'});
 assert.equal(result.entries.length,0);assert.equal(result.available,false);assert.deepEqual(seen,[1,1]);assert.equal(reads,2);
});
