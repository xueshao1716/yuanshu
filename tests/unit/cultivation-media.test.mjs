import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {controlFixture} from '../helpers/cultivation-fixture.mjs';
import {createCultivationRuntime} from '../../engine/cultivation/runtime.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcS8AAAAASUVORK5CYII=','base64');
async function fixture(t){
  const f=await controlFixture(t),{agentId}=await f.register();
  fs.mkdirSync(path.join(f.root,'workshop-out'));
  fs.writeFileSync(path.join(f.root,'workshop-out/portrait.png'),png);
  const open=()=>createCultivationRuntime({wsRoot:f.root,identityAdapters:{
    resolveMother:s=>s===f.mother?{actorId:'fixture-mother',originId:'fixture-run'}:null,
    resolveHuman:s=>s===f.human?{actorId:'fixture-user',originId:'fixture-grant'}:null}});
  const runtime=open(),bind=f.command('asset.bind',{agentId,kind:'appearance',path:'workshop-out/portrait.png'});
  return {...f,agentId,runtime,open,bind};
}
test('media is content-pinned to one agent and survives restart without source dependence',async t=>{
  const f=await fixture(t),result=await f.runtime.execute(f.bind,'mother',f.mother);
  assert.equal(result.asset.version,1);
  const target={agentId:f.agentId,kind:'appearance',...result.asset};
  assert.deepEqual(await f.runtime.execute(f.bind,'mother',f.mother),result);
  fs.unlinkSync(path.join(f.root,'workshop-out/portrait.png'));
  assert.equal(f.open().media(target).base64,png.toString('base64'));
  assert.throws(()=>f.runtime.media({...target,agentId:randomUUID()}),/asset_unverified/);
  assert.throws(()=>f.runtime.media({...target,kind:'voice'}),/asset_unverified/);
  const revoke=f.command('asset.revoke',{agentId:f.agentId,id:result.asset.id,version:1});
  await f.runtime.execute(revoke,'human',f.human);
  assert.throws(()=>f.open().media(target),/asset_unverified/);
});
test('media refuses foreign ownership, paths, links and non-media content',async t=>{
  const f=await fixture(t);
  for(const p of ['../secret','工程/secret','workshop-out/../secret'])
    await assert.rejects(f.runtime.execute({...f.bind,requestId:randomUUID(),payload:{...f.bind.payload,path:p}},'mother',f.mother),/asset_unverified/);
  await assert.rejects(f.runtime.execute({...f.bind,payload:{...f.bind.payload,agentId:randomUUID()}},'mother',f.mother),/identity_denied/);
  const linked=path.join(f.root,'workshop-out/link.png');fs.linkSync(path.join(f.root,'workshop-out/portrait.png'),linked);
  await assert.rejects(f.runtime.execute({...f.bind,payload:{...f.bind.payload,path:'workshop-out/link.png'}},'mother',f.mother),/asset_unverified/);
  fs.unlinkSync(linked);fs.writeFileSync(path.join(f.root,'workshop-out/portrait.png'),'<svg onload="alert(1)"/>');
  await assert.rejects(f.runtime.execute(f.bind,'mother',f.mother),/asset_unverified/);
});
test('bound content mutation is detected before use or adoption',async t=>{
  const f=await fixture(t),result=await f.runtime.execute(f.bind,'mother',f.mother);
  const file=path.join(f.root,'工程/智能体培养/media',f.agentId,result.asset.id+'.bin');
  fs.writeFileSync(file,Buffer.concat([png,Buffer.from('changed')]));
  assert.throws(()=>f.runtime.media({agentId:f.agentId,kind:'appearance',...result.asset}),/asset_unverified/);
});

test('asset identity cannot silently change when registry hash and bytes are both replaced',async t=>{
  const f=await fixture(t),result=await f.runtime.execute(f.bind,'mother',f.mother);
  const root=path.join(f.root,'工程/智能体培养/media'),registry=path.join(root,'registry.json');
  const data=JSON.parse(fs.readFileSync(registry)),changed=Buffer.concat([png,Buffer.from('different')]);
  data.records[0].hash=createHash('sha256').update(changed).digest('hex');
  fs.writeFileSync(path.join(root,f.agentId,result.asset.id+'.bin'),changed);
  fs.writeFileSync(registry,JSON.stringify(data));
  assert.throws(()=>f.runtime.media({agentId:f.agentId,kind:'appearance',...result.asset}),/asset_unverified/);
});
