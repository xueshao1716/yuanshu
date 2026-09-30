import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8');
test('server composes knowledge with foreground priority, bearer routes, lifecycle and teardown',()=>{
 const s=read('server.mjs');
 for(const text of ['createKnowledgeRuntime({','catalog: () => modelList','voiceAdmission.isActive()','knowledgeRuntime.enqueueFinished(run)',
  'knowledgeApi.handle(req, res, url)','req.headers.authorization === `Bearer ${CONFIG.token}`','knowledgeRuntime.start()',
  'knowledgeRuntime.close()','knowledgeChatContext(knowledgeRuntime,','knowledgeContext,','deliverKnowledgeContext(entry.agent,']) assert.ok(s.includes(text),text);
 assert.ok(s.includes('learningIntake.enqueue(run)'),'preserve old intake');
 assert.ok(s.indexOf('knowledgeApi.handle(req, res, url)')<s.indexOf('Object.freeze(API_ROUTES)'));
});
test('unified chat supplies attributed knowledge only as separate task data before the actual user message',()=>{
 const s=read('engine/unified-chat.mjs');
 assert.ok(s.includes('runContext?.knowledgeContext'));
 assert.ok(s.includes("role: 'user', content: runContext.knowledgeContext"));
 assert.ok(!s.includes('runtime: runContext?.knowledgeContext'));
});

test('both aibody overview routes use the isolated read-only knowledge projection',()=>{
 const s=read('server.mjs');
 for(const route of ['/api/aibody"','/api/aibody/overview"']){
  const line=s.split('\n').find(l=>l.includes(route));
  assert.ok(line?.includes('knowledgeOverview('),route);
 }
 assert.ok(s.includes('createKnowledgeOverview({ aibodyRuntime, knowledgeRuntime })'));
});

test('overview adds same-scope stages without changing aibody state or hiding its result on failure',async()=>{
 const m=await import('../../engine/knowledge-overview.mjs').catch(()=>({}));
 assert.equal(typeof m.createKnowledgeOverview,'function');
 const base={genes:[],emotion:{value:1}},calls=[];
 const input={sessionId:'s1',runId:'r1'};
 const overview=m.createKnowledgeOverview({aibodyRuntime:{overview:s=>{calls.push(s);return base;}},
  knowledgeRuntime:{projection:async s=>{calls.push(s);return {total:1,methodVerified:false};}}});
 assert.deepEqual(await overview(input),{...base,knowledge:{available:true,total:1,methodVerified:false}});
 assert.deepEqual(calls,[input,input]);assert.equal(base.knowledge,undefined);
 const failing=m.createKnowledgeOverview({aibodyRuntime:{overview:()=>base},knowledgeRuntime:{projection:async()=>{throw Error('private path');}}});
 assert.deepEqual(await failing(input),{...base,knowledge:{available:false,reason:'knowledge_unavailable'}});
});
