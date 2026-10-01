import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {controlFixture,enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createCultivationApi} from '../../engine/cultivation/api.mjs';

test('HTTP grants bind exact action, revision and body; bearer alone never authorizes',async t=>{
  const f=await controlFixture(t),{publicKey,privateKey}=generateKeyPairSync('ed25519');
  const runtime=createCultivationRuntime({wsRoot:f.root,humanConfig:{publicKey,actorId:'synthetic-human'}});
  const api=createCultivationApi({runtime,requireAuth:r=>r.headers.authorization==='Bearer synthetic',
    readBody:r=>r.body,json:(res,status,body)=>Object.assign(res,{status,body})});
  const call=async(path,method,body,proof)=>{const res={};
    await api.handle({method,body,headers:{authorization:'Bearer synthetic',
      ...(proof?{'x-cultivation-proof':JSON.stringify(proof)}:{})}},res,new URL(`http://fixture/api/cultivation${path}`));return res;};
  const {action,...body}=f.command('policy.set',{policy:enabledPolicy()});
  assert.equal((await call('/policy','PUT',body)).status,403);
  const challenge=await call('/grants/challenge','POST',{method:'PUT',path:'/policy',body});
  assert.equal(challenge.status,200);
  assert.equal(f.store.read('control').revision,0);
  const proof={id:challenge.body.id,signature:sign(null,Buffer.from(challenge.body.message),privateKey).toString('base64url')};
  assert.equal((await call('/policy','PUT',{...body,expectedRevision:1},proof)).status,403);
  assert.equal((await call('/policy','PUT',body,proof)).status,200);
  assert.equal((await call('/policy','PUT',body,proof)).status,403);
  assert.equal((await call('/grants/challenge','POST',{method:'POST',path:'/designs',body})).status,403);
  assert.equal((await call('/grants/challenge','POST',{method:'PUT',path:'/policy',body:{...body,author:'user'}})).status,400);
  for(const invalid of [{...body,requestId:'bad'},{...body,expectedRevision:-1},{...body,payload:{policy:{enabled:true}}}])
    assert.equal((await call('/grants/challenge','POST',{method:'PUT',path:'/policy',body:invalid})).status,400);
  assert.equal((await call('/runs/00000000-0000-4000-8000-000000000001/cancel','POST',
    {...body,payload:{runId:'forged'}})).status,400);
  await runtime.close();
});
