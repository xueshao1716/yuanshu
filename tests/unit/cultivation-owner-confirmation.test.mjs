import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';

const moduleUrl=new URL('../../engine/cultivation/owner-webauthn.mjs',import.meta.url);
const hash=v=>createHash('sha256').update(v).digest();
function credential(){
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'});
  const id=Buffer.from('fixture-credential');
  const cose=Buffer.concat([Buffer.from([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,32]),Buffer.from(jwk.x,'base64url'),Buffer.from([0x22,0x58,32]),Buffer.from(jwk.y,'base64url')]);
  const auth=Buffer.concat([hash('yuanshu.localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,id.length]),id,cose]);
  return {...keys,id,auth};
}
function proof(c,message,mutate=x=>x){
  const data=mutate({type:'webauthn.get',origin:'https://yuanshu.localhost',challenge:Buffer.from(message).toString('base64url'),crossOrigin:false});
  const client=Buffer.from(JSON.stringify(data)),auth=Buffer.concat([hash('yuanshu.localhost'),Buffer.from([5,0,0,0,1])]);
  const signature=sign('sha256',Buffer.concat([auth,hash(client)]),c.privateKey);
  return Buffer.from(JSON.stringify({credentialId:c.id.toString('base64url'),authenticatorData:auth.toString('base64url'),clientData:client.toString('base64url'),signature:signature.toString('base64url')})).toString('base64url');
}
test('owner WebAuthn verifies real P256 proof bound to RP, UV, challenge and credential',async()=>{
  assert.ok(fs.existsSync(moduleUrl),'native owner verification module exists');
  const {readOwnerCredential,verifyOwnerAssertion}=await import(moduleUrl),c=credential();
  const config=readOwnerCredential({version:1,workspace:'a'.repeat(64),authenticatorData:c.auth.toString('base64url')},'a'.repeat(64));
  assert.equal(verifyOwnerAssertion(config,'exact-operation',proof(c,'exact-operation')),true);
  for(const bad of [proof(c,'other-operation'),proof(c,'exact-operation',v=>({...v,origin:'https://evil.test'})),proof(c,'exact-operation',v=>({...v,crossOrigin:true})),proof(c,'exact-operation',v=>({...v,crossOrigin:'false'})),proof(credential(),'exact-operation'),'garbage'])
    assert.equal(verifyOwnerAssertion(config,'exact-operation',bad),false);
  const badAuth=JSON.parse(Buffer.from(proof(c,'exact-operation'),'base64url'));badAuth.authenticatorData=Buffer.alloc(37).toString('base64url');
  assert.equal(verifyOwnerAssertion(config,'exact-operation',Buffer.from(JSON.stringify(badAuth)).toString('base64url')),false);
  assert.throws(()=>readOwnerCredential({version:1,workspace:'b'.repeat(64),authenticatorData:c.auth.toString('base64url')},'a'.repeat(64)));
  for(const auth of [c.auth.subarray(0,60),Buffer.concat([c.auth,Buffer.from([0])]),Buffer.alloc(40000)])
    assert.throws(()=>readOwnerCredential({version:1,workspace:'a'.repeat(64),authenticatorData:auth.toString('base64url')},'a'.repeat(64)));
});
test('native owner grants stay command-bound, single-use and revoke on file replacement',async t=>{
  const url=new URL('../../engine/cultivation/owner-grants.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'host-only pinned owner grants exist');
  const {createOwnerGrants}=await import(url),{readOwnerCredential}=await import(moduleUrl);
  const c=credential(),workspace='a'.repeat(64);let raw=null;
  const provider=()=>raw&&readOwnerCredential(raw,workspace);
  const grants=createOwnerGrants({workspace,provider,now:()=>1000});
  assert.equal(grants.available,false);
  raw={version:1,workspace,authenticatorData:c.auth.toString('base64url')};
  assert.equal(grants.available,true);
  const command={action:'policy.set',payload:{enabled:false}},challenge=grants.challenge(command);
  const signed={id:challenge.id,signature:proof(c,challenge.message)};
  assert.throws(()=>grants.verify(signed,{...command,payload:{enabled:true}}));
  const source=grants.verify(signed,command);
  assert.throws(()=>grants.verify(signed,command));
  const {commandHash}=await import('../../engine/cultivation/identity.mjs');
  const context={kind:'human',workspace,commandHash:commandHash(command)};
  assert.equal(grants.resolveHuman(source,context).actorId,'windows-hello-owner');
  raw={...raw,authenticatorData:credential().auth.toString('base64url')};
  assert.equal(grants.available,false);
  assert.equal(grants.resolveHuman(source,context),null);
  raw={version:1,workspace,authenticatorData:c.auth.toString('base64url')};
  assert.equal(grants.available,false,'replacement locks until trusted restart');
});
test('owner config never enrolls, validates workspace and disables on corruption',async t=>{
  const url=new URL('../../engine/cultivation/owner-config.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'local owner credential loader exists');
  const {ownerConfigProvider}=await import(url),root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace='a'.repeat(64),dir=path.join(root,'Yuanshu','owner-confirmation'),file=path.join(dir,workspace+'.json');
  const read=ownerConfigProvider({workspace,env:{LOCALAPPDATA:root},platform:'win32'});
  assert.equal(read(),null);assert.equal(fs.existsSync(dir),false);
  fs.mkdirSync(dir,{recursive:true});const c=credential();
  fs.writeFileSync(file,JSON.stringify({version:1,workspace,authenticatorData:c.auth.toString('base64url')}));
  assert.equal(read().mode,'windows-hello');
  fs.writeFileSync(file,'{}');assert.throws(()=>read());
});
test('owner UI distinguishes pairing, unavailable Hello, advanced signing and bounded preset',()=>{
  const source=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8'):'';
  const owner=source('frontend/src/soul/cultivation/OwnerConfirmation.tsx');
  for(const text of ['Windows Hello','owner_confirmation_status','owner_confirmation_pair','高级签名','不会开启学习'])assert.ok(owner.includes(text),text);
  const auth=source('frontend/src/soul/cultivation/Authorization.tsx');
  assert.ok(auth.includes('owner_confirmation_sign'));
  assert.ok(auth.includes('useRef'),'double click guard');
  assert.ok(source('frontend/src/soul/cultivation/Resources.tsx').includes('仅采用已核查经验'));
});
