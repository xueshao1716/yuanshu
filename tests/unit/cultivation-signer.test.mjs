import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {createHumanGrants} from '../../engine/cultivation/human-grants.mjs';

test('offline signer checks exact target and requires explicit human confirmation',async()=>{
  const {reviewChallenge,signChallenge}=await import('../../scripts/cultivation-sign.mjs');
  const {commandFor}=await import('../../engine/cultivation/api.mjs');
  const keys=generateKeyPairSync('ed25519'),workspace='a'.repeat(64),now=10000;
  const command={method:'POST',path:'/agents/'+randomUUID()+'/pause',body:{requestId:randomUUID(),expectedRevision:1,payload:{}}};
  const grants=createHumanGrants({workspace,actorId:'synthetic-human',publicKey:keys.publicKey,now:()=>now});
  const pkg={...grants.challenge(commandFor(command.method,command.path,command.body)),command};
  const reviewed=reviewChallenge(pkg,{workspace,now});assert.equal(reviewed.command.action,'agent.pause');
  assert.throws(()=>signChallenge(pkg,{workspace,now,privateKey:keys.privateKey,confirmation:''}),/confirmation/);
  const signature=signChallenge(pkg,{workspace,now,privateKey:keys.privateKey,confirmation:'APPROVE '+pkg.id});
  assert.ok(verify(null,Buffer.from(pkg.message),keys.publicKey,Buffer.from(signature,'base64url')));
  for(const bad of [{...pkg,command:{...command,path:'/agents/'+randomUUID()+'/archive'}},{...pkg,expiresAt:9000},
    {...pkg,message:pkg.message.replace('human-v1','human-v9')}])assert.throws(()=>reviewChallenge(bad,{workspace,now}));
  assert.throws(()=>reviewChallenge(pkg,{workspace:'b'.repeat(64),now}));
  assert.throws(()=>reviewChallenge(pkg,{workspace,now:50000}));
});
