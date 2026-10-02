import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSessionGrants} from '../../engine/cultivation/session-grants.mjs';
import registry from '../../engine/tools/confirm-registry.mjs';
import {commandHash} from '../../engine/cultivation/identity.mjs';
import {controlFixture, draft, enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';
import {createCultivationApi} from '../../engine/cultivation/api.mjs';

function setup(t) {
  const sessionId=randomUUID(),workspace='a'.repeat(64),pushed=[];
  let now=Date.now(),active=true;
  const host={registry,canAccess:id=>active&&id===sessionId,push:(...args)=>pushed.push(args)};
  const grants=createSessionGrants({workspace,now:()=>now,host});
  t.after(()=>{grants.revoke();registry.cancelAll(sessionId);});
  const command={action:'policy.set',requestId:randomUUID(),expectedRevision:0,payload:{policy:enabledPolicy()}};
  return {grants,command,sessionId,workspace,pushed,host,expire:()=>now+=60001,remove:()=>active=false};
}
test('session grants are unavailable unless a trusted host installs session validation and confirmation',()=>{
  const g=createSessionGrants({workspace:'a'.repeat(64)});
  assert.equal(g.available,false);
  assert.throws(()=>g.challenge({},'invented'),/identity_unavailable/);
});
test('challenge is only a request; proof requires the existing confirmation registry approval',async t=>{
  const f=setup(t),c=f.grants.challenge(f.command,f.sessionId);
  assert.equal(f.pushed.length,1);
  const pending=registry.list().find(x=>x.id===c.id);
  assert.equal(pending.toolName,'cultivation-policy');
  assert.ok(pending.reason.includes('fixture-model'));
  assert.equal(pending.sessionId,f.sessionId);
  let complete=false;
  const waiting=f.grants.confirm(c.id,f.command,f.sessionId).then(p=>{complete=true;return p;});
  await Promise.resolve();assert.equal(complete,false,'challenge alone cannot approve');
  registry.settle(f.sessionId,c.id,true);
  const proof=await waiting;
  const source=f.grants.verify(proof,f.command,f.sessionId);
  assert.ok(f.grants.resolveHuman(source,{workspace:f.workspace,kind:'human',commandHash:commandHash(f.command)}));
  assert.throws(()=>f.grants.verify(proof,f.command,f.sessionId),/identity_denied/);
  f.grants.revoke();
  assert.equal(f.grants.resolveHuman(source,{workspace:f.workspace,kind:'human',commandHash:commandHash(f.command)}),null);
});
test('session confirmation rejects invented sessions, other actions, denied approval and changed commands',async t=>{
  const f=setup(t);
  assert.throws(()=>f.grants.challenge(f.command,'invented'),/identity_denied/);
  assert.throws(()=>f.grants.challenge({...f.command,action:'agent.register'},f.sessionId),/identity_denied/);
  const c=f.grants.challenge(f.command,f.sessionId);
  await assert.rejects(async()=>f.grants.confirm(c.id,{...f.command,requestId:randomUUID()},f.sessionId),/identity_denied/);
  registry.settle(f.sessionId,c.id,false);
  await assert.rejects(async()=>f.grants.confirm(c.id,f.command,f.sessionId),/identity_denied/);
});
test('issued proof remains bound to command, workspace, live session, expiry and host epoch',async t=>{
  for(const invalidate of ['session','expiry','revoke']) {
    const f=setup(t),c=f.grants.challenge(f.command,f.sessionId);
    registry.settle(f.sessionId,c.id,true);
    const proof=await f.grants.confirm(c.id,f.command,f.sessionId);
    assert.throws(()=>f.grants.verify(proof,{...f.command,expectedRevision:1},f.sessionId),/identity_denied/);
    const source=f.grants.verify(proof,f.command,f.sessionId);
    const context={workspace:f.workspace,kind:'human',commandHash:commandHash(f.command)};
    assert.equal(f.grants.resolveHuman(source,{...context,workspace:'b'.repeat(64)}),null);
    if(invalidate==='session')f.remove();else if(invalidate==='expiry')f.expire();else f.grants.revoke();
    assert.equal(f.grants.resolveHuman(source,context),null);
  }
});

test('cancelled session confirmation releases its slot without requesting a proof',async t=>{
  for(const outcome of ['rejected','cancelled']) {
    const f=setup(t),first=f.grants.challenge(f.command,f.sessionId);
    assert.throws(()=>f.grants.challenge(f.command,f.sessionId),/identity_denied/);
    if(outcome==='rejected')registry.settle(f.sessionId,first.id,false);
    else registry.cancelAll(f.sessionId);
    await Promise.resolve();
    const next=f.grants.challenge({...f.command,requestId:randomUUID()},f.sessionId);
    assert.notEqual(next.id,first.id);
    await assert.rejects(f.grants.confirm(first.id,f.command,f.sessionId),/identity_denied/);
    assert.equal(registry.list().filter(row=>row.sessionId===f.sessionId).length,1);
  }
});

test('approval waiting rejects duplicate claims, revocation, session loss, expiry and command mutation',async t=>{
  for(const invalidate of ['revoke','session','expiry','mutation']) {
    const f=setup(t),c=f.grants.challenge(f.command,f.sessionId);
    const waiting=f.grants.confirm(c.id,f.command,f.sessionId);
    await assert.rejects(f.grants.confirm(c.id,f.command,f.sessionId),/identity_denied/);
    if(invalidate==='revoke')f.grants.revoke();
    else if(invalidate==='session')f.remove();
    else if(invalidate==='expiry')f.expire();
    else f.command.payload.policy.dailyRequests++;
    registry.settle(f.sessionId,c.id,true);
    await assert.rejects(waiting,/identity_denied/);
  }
});
test('Android confirmation authorizes exactly one policy; genuine mother can then revise and register without dispatch',async t=>{
  const f=await controlFixture(t),s=setup(t);
  const runtime=createCultivationRuntime({wsRoot:f.root,sessionApproval:s.host,identityAdapters:{
    resolveMother:source=>source===f.mother?{actorId:'fixture-mother',originId:'fixture-run'}:null}});
  t.after(()=>runtime.close());
  const routes=createCultivationApi({runtime,readBody:req=>req.body,requireAuth:()=>true,json:(res,status,body)=>Object.assign(res,{status,body})});
  const call=async(path,body,headers={},method='POST')=>{
    const res={};await routes.handle({method,body,headers},res,new URL('http://local/api/cultivation'+path));return res;
  };
  const d=draft(),submitted=await runtime.execute(f.command('design.submit',{design:d}),'mother',f.mother);
  await assert.rejects(runtime.execute(f.command('agent.register',{designId:submitted.result.id}),'mother',f.mother),/policy_disabled/);
  const policy={...enabledPolicy(),allowRemote:true};
  const {action:unused,...body}=f.command('policy.set',{policy});
  const request={method:'PUT',path:'/policy',body,sessionId:s.sessionId};
  const challenge=await call('/grants/session/challenge',request);
  assert.equal(challenge.status,200,JSON.stringify(challenge));
  registry.settle(s.sessionId,challenge.body.id,true);
  const confirmed=await call('/grants/session/confirm',{...request,id:challenge.body.id});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed));
  const headers={'x-cultivation-session-proof':JSON.stringify(confirmed.body),'x-cultivation-session-id':s.sessionId};
  assert.equal((await call('/policy',body,headers,'PUT')).status,200);
  assert.equal((await call('/policy',body,headers,'PUT')).status,403);
  d.permissions.remote=true;
  const revised=await runtime.execute(f.command('design.revise',{parentId:submitted.result.id,design:d}),'mother',f.mother);
  await runtime.execute(f.command('agent.register',{designId:revised.result.id}),'mother',f.mother);
  const state=await runtime.overview();
  assert.equal(state.agentCount,1);assert.equal(state.executorAvailable,false);
  assert.equal(f.store.read('control').data.designs.length,2);
});
