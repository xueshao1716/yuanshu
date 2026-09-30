import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../../engine/knowledge-api.mjs').catch(()=>({}));
function api(runtime){assert.equal(typeof module.createKnowledgeApi,'function');return module.createKnowledgeApi({runtime,
 readBody:async req=>req.body,json:(res,status,body)=>Object.assign(res,{status,body}),requireAuth:req=>req.headers?.authorization==='Bearer valid'});}
test('knowledge routes reject URL-only authentication and do not mutate on reads',async()=>{
 let writes=0;const routes=api({status:async()=>({ok:true}),updatePolicy:()=>writes++});
 const res={};await routes.handle({method:'POST',headers:{},body:{revision:1,patch:{}}},res,new URL('http://local/api/knowledge/policy?token=valid'));
 assert.equal(res.status,401);assert.equal(writes,0);
 const read={};await routes.handle({method:'GET',headers:{authorization:'Bearer valid'}},read,new URL('http://local/api/knowledge/status'));
 assert.equal(read.status,200);assert.equal(writes,0);
});
test('API validates pagination, revisions, JSON and hides internal/private errors',async()=>{
 const a=api({store:{list:async({offset,limit})=>({offset,limit,items:[]})},updatePolicy:async()=>{throw Object.assign(Error('secret path'),{code:'revision_conflict'});}});
 const call=async(path,method='GET',body)=>{const res={};await a.handle({method,body,headers:{authorization:'Bearer valid'}},res,new URL('http://local'+path));return res;};
 assert.equal((await call('/api/knowledge/jobs?offset=-1')).status,400);
 assert.deepEqual((await call('/api/knowledge/jobs?offset=20&limit=20')).body,{offset:20,limit:20,items:[]});
 const stale=await call('/api/knowledge/policy','POST',{revision:1,patch:{}});assert.equal(stale.status,409);assert.equal(stale.body.error,'revision_conflict');assert.ok(!JSON.stringify(stale).includes('secret'));
 assert.equal((await call('/api/knowledge/enqueue','POST',null)).status,400);
});

test('supplement route requires authentication and both revisions, retaining parent identity',async()=>{
 const calls=[],id='a'.repeat(64);const routes=api({supplement:async(...args)=>{calls.push(args);return {relatedJobId:args[0],state:'queued'};}});
 const call=async(body,auth=true)=>{const res={};await routes.handle({method:'POST',body,headers:auth?{authorization:'Bearer valid'}:{}},res,new URL(`http://local/api/knowledge/jobs/${id}/supplement`));return res;};
 const source={kind:'file',path:'docs/evidence.txt'};
 assert.equal((await call({revision:3,policyRevision:2,source},false)).status,401);
 assert.equal((await call({revision:3,source})).status,400);assert.equal(calls.length,0);
 assert.equal((await call({revision:3,policyRevision:2,source})).status,202);
 assert.deepEqual(calls,[[id,source,3,2]]);
});

test('job details expose read-only provenance only through the detail adapter',async()=>{
 let reads=0;const id='a'.repeat(64),value={id,provenance:{status:'available',methodVerified:false}};
 const routes=api({detail:async key=>{assert.equal(key,id);reads++;return value;}}),res={};
 await routes.handle({method:'GET',headers:{authorization:'Bearer valid'}},res,new URL(`http://local/api/knowledge/jobs/${id}`));
 assert.equal(res.status,200);assert.deepEqual(res.body,value);assert.equal(reads,1);
});
test('review requires authentication and policy revision, backend supplies operation provenance',async()=>{
 const calls=[],id='a'.repeat(64),routes=api({review:async(...args)=>{calls.push(args);return {state:'queued'};}});
 const call=async(body,auth=true)=>{const res={};await routes.handle({method:'POST',body,headers:auth?{authorization:'Bearer valid'}:{}},res,new URL(`http://local/api/knowledge/jobs/${id}/review`));return res;};
 const body={revision:4,policyRevision:2,decision:'accept_source',note:'核对来源',confirmed:true,reviewer:'model'};
 assert.equal((await call(body,false)).status,401);assert.equal((await call({...body,policyRevision:undefined})).status,400);
 assert.equal((await call(body)).status,200);assert.equal(calls.length,1);assert.equal(calls[0][0],id);
 assert.equal(calls[0][1].reviewer,undefined);assert.deepEqual(calls[0].slice(2),[4,2]);
});
