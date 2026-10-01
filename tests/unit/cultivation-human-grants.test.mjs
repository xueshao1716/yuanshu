import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {commandHash, createIdentityAuthority} from '../../engine/cultivation/identity.mjs';

test('human grants bind an external key, workspace, command and expiring single-use proof', async () => {
  const module = await import('../../engine/cultivation/human-grants.mjs');
  assert.equal(typeof module.createHumanGrants, 'function');
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  let clock = 1000;
  const workspace = 'a'.repeat(64), command = {action:'policy.set',payload:{enabled:false}};
  const grants = module.createHumanGrants({workspace, publicKey, actorId:'fixture-user', now:()=>clock});
  const challenge = grants.challenge(command);
  const proof = {id:challenge.id, signature:sign(null,Buffer.from(challenge.message),privateKey).toString('base64url')};
  const source = grants.verify(proof,command);
  const context = {workspace,commandHash:commandHash(command),kind:'human'};
  assert.equal(grants.resolveHuman(source,context).actorId,'fixture-user');
  assert.equal(grants.resolveHuman({},context),null);
  assert.equal(grants.resolveHuman(source,{...context,workspace:'b'.repeat(64)}),null);
  assert.equal(grants.resolveHuman(source,{...context,commandHash:'0'.repeat(64)}),null);
  assert.throws(()=>grants.verify(proof,command),/identity_denied/);
  const authority = createIdentityAuthority({workspace,now:()=>clock,resolveHuman:grants.resolveHuman});
  const principal = authority.issue('human',source,command);
  assert.equal(authority.assert(principal,command,['human']).actorId,'fixture-user');
  grants.revoke();
  assert.throws(()=>authority.assert(principal,command,['human']),/identity_denied/);
  const expired=grants.challenge(command); clock+=60001;
  assert.throws(()=>grants.verify({id:expired.id,signature:sign(null,Buffer.from(expired.message),privateKey).toString('base64url')},command),/identity_denied/);
});

test('missing key, foreign key, mutated command, private key and malformed proof fail closed',async()=>{
  const {createHumanGrants}=await import('../../engine/cultivation/human-grants.mjs');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'), other=generateKeyPairSync('ed25519');
  const opts={workspace:'a'.repeat(64),actorId:'fixture-user'};
  assert.throws(()=>createHumanGrants({...opts,publicKey:privateKey}),/identity_unavailable/);
  const privatePem=privateKey.export({type:'pkcs8',format:'pem'});
  for(const serialized of [privatePem,Buffer.from(privatePem),{key:privatePem}])
    assert.throws(()=>createHumanGrants({...opts,publicKey:serialized}),/identity_unavailable/);
  assert.throws(()=>createHumanGrants({...opts,publicKey,actorId:' fixture-user '}),/identity_unavailable/);
  assert.equal(createHumanGrants({...opts,publicKey:publicKey.export({type:'spki',format:'pem'})}).available,true);
  const disabled=createHumanGrants(opts);
  assert.equal(disabled.available,false);
  assert.throws(()=>disabled.challenge({a:1}),/identity_unavailable/);
  const grants=createHumanGrants({...opts,publicKey}),command={a:1},c=grants.challenge(command);
  const proof=key=>({id:c.id,signature:sign(null,Buffer.from(c.message),key).toString('base64url')});
  assert.throws(()=>grants.verify(proof(other.privateKey),command),/identity_denied/);
  assert.throws(()=>grants.verify(proof(privateKey),{a:2}),/identity_denied/);
  assert.throws(()=>grants.verify({...proof(privateKey),actorId:'injected'},command),/identity_denied/);
  assert.ok(grants.verify(proof(privateKey),command));
});
