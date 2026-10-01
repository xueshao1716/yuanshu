import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';

test('human configuration requires an explicit external public key and never enrolls a key',async t=>{
  const url=new URL('../../engine/cultivation/human-config.mjs',import.meta.url);
  assert.ok(fs.existsSync(url),'host human configuration loader exists');
  const {loadCultivationHumanConfig}=await import(url),f=await controlFixture(t);
  assert.equal(loadCultivationHumanConfig({env:{}}),undefined);
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const file=path.join(f.root,'public.pem'),env={YUANSHU_CULTIVATION_HUMAN_PUBLIC_KEY_FILE:file,YUANSHU_CULTIVATION_HUMAN_ACTOR:'fixture-human'};
  fs.writeFileSync(file,publicKey.export({type:'spki',format:'pem'}));
  assert.equal(loadCultivationHumanConfig({env}).actorId,'fixture-human');
  assert.throws(()=>loadCultivationHumanConfig({env:{...env,YUANSHU_CULTIVATION_HUMAN_ACTOR:''}}),/identity_unavailable/);
  fs.writeFileSync(file,privateKey.export({type:'pkcs8',format:'pem'}));
  assert.throws(()=>loadCultivationHumanConfig({env}),/identity_unavailable/);
  assert.throws(()=>loadCultivationHumanConfig({env:{...env,YUANSHU_CULTIVATION_HUMAN_PUBLIC_KEY_FILE:'relative.pem'}}),/identity_unavailable/);
});

test('bad optional trust configuration disables only human writes, not the whole service',async()=>{
  const {optionalCultivationHumanConfig}=await import('../../engine/cultivation/human-config.mjs');
  assert.equal(typeof optionalCultivationHumanConfig,'function');
  const warnings=[];
  assert.equal(optionalCultivationHumanConfig({env:{YUANSHU_CULTIVATION_HUMAN_ACTOR:'incomplete'},warn:v=>warnings.push(v)}),undefined);
  assert.deepEqual(warnings,['cultivation_identity_unavailable']);
});
