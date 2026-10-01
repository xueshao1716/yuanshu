import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {credential,proof} from '../helpers/owner-credential.mjs';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createCultivationApi} from '../../engine/cultivation/api.mjs';
import {readOwnerCredential} from '../../engine/cultivation/owner-webauthn.mjs';
import {defaultPolicy} from '../../engine/cultivation/policy.mjs';

async function fixture(t){
  const f=await controlFixture(t),key=credential();let raw=null,clock=Date.parse('2026-10-01');
  const runtime=createCultivationRuntime({wsRoot:f.root,now:()=>clock,
    ownerProvider:workspace=>()=>raw&&readOwnerCredential(raw,workspace)});
  t.after(()=>runtime.close());
  const api=createCultivationApi({runtime,readBody:req=>req.body,
    requireAuth:async req=>req.headers.authorization==='Bearer synthetic',
    json:(res,status,body)=>Object.assign(res,{status,body})});
  const call=async(path,method='GET',body,signed,auth=true)=>{
    const req={method,body,headers:{...(auth?{authorization:'Bearer synthetic'}:{}),
      ...(signed?{'x-cultivation-proof':JSON.stringify(signed)}:{})}},res={};
    await api.handle(req,res,new URL('http://fixture/api/cultivation'+path));return res;
  };
  const request=revision=>({method:'PUT',path:'/policy',body:{requestId:randomUUID(),expectedRevision:revision,
    payload:{policy:{...defaultPolicy(),enabled:true,motherLearning:true,dataScopes:['knowledge:approved-cultivation'],expiresAt:'2026-10-08T00:00:00.000Z'}}}});
  const signRequest=async cmd=>{const c=await call('/grants/challenge','POST',cmd);assert.equal(c.status,200);return {id:c.body.id,signature:proof(key,c.body.message)};};
  return {...f,call,runtime,request,signRequest,
    enroll:()=>{raw={version:1,workspace:f.store.workspace,authenticatorData:key.auth.toString('base64url')};},
    remove:()=>{raw=null;},corrupt:()=>{raw={};},advance:ms=>{clock+=ms;}};
}
test('native owner API enrolls dynamically without granting policy and requires exact signed writes',async t=>{
  const f=await fixture(t),cmd=f.request(0);
  assert.equal((await f.call('/overview')).body.ownerConfirmation.state,'unpaired');
  assert.equal((await f.call('/grants/challenge','POST',cmd)).status,503);
  f.enroll();
  const ready=(await f.call('/overview')).body;
  assert.equal(ready.humanGrantAvailable,true);assert.equal(ready.policy.enabled,false);
  assert.equal((await f.call('/policy','PUT',cmd.body)).status,403);
  assert.equal((await f.call('/grants/challenge','POST',cmd,undefined,false)).status,401);
  const signed=await f.signRequest(cmd),changed=structuredClone(cmd.body);changed.payload.policy.allowRemote=true;
  assert.equal((await f.call('/policy','PUT',changed,signed)).status,403);
  assert.equal((await f.call('/policy','PUT',cmd.body,signed)).status,200);
  assert.equal((await f.call('/policy','PUT',cmd.body,signed)).status,403);
  const after=(await f.call('/overview')).body;
  assert.equal(after.revision,1);assert.equal(after.policy.motherLearning,true);
  assert.equal(after.policy.dailyRequests,0);assert.equal(after.policy.allowRemote,false);
  const stale=f.request(0),staleProof=await f.signRequest(stale);
  assert.equal((await f.call('/policy','PUT',stale.body,staleProof)).status,409);
  assert.equal((await f.call('/policy','PUT',stale.body,staleProof)).status,403);
  const expiring=f.request(1),expiredProof=await f.signRequest(expiring);f.advance(60000);
  assert.equal((await f.call('/policy','PUT',expiring.body,expiredProof)).status,403);
  assert.equal(f.store.read('control').revision,1);
});
test('removal or corruption revokes outstanding owner proof and never silently replaces identity',async t=>{
  for(const loss of ['remove','corrupt']){
    const f=await fixture(t);f.enroll();const cmd=f.request(0),signed=await f.signRequest(cmd);
    f[loss]();assert.equal((await f.call('/policy','PUT',cmd.body,signed)).status,503);
    f.enroll();const state=(await f.call('/overview')).body;
    assert.equal(state.ownerConfirmation.state,'locked');assert.equal(state.humanGrantAvailable,false);
    assert.equal(state.revision,0);assert.equal(state.policy.enabled,false);
  }
});
test('external owner configuration keeps priority over local Hello credentials',async t=>{
  const f=await controlFixture(t),{publicKey}=generateKeyPairSync('ed25519');let reads=0;
  const runtime=createCultivationRuntime({wsRoot:f.root,humanConfig:{publicKey,actorId:'external-fixture'},ownerProvider:()=>{reads++;throw Error('must not fall back');}});
  t.after(()=>runtime.close());
  const value=await runtime.overview();
  assert.equal(value.ownerConfirmation.mode,'external-signature');assert.equal(value.humanGrantAvailable,true);assert.equal(reads,0);
});
