import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DEFINITION, PERSONA_BEGIN, PERSONA_END, syncAppendSystemPersona } from '../../engine/persona-def.mjs';
import { createPersonaGovernance } from '../../engine/persona-governance.mjs';
import { createPersonaApproval } from '../../engine/persona-approval.mjs';
import registry from '../../engine/tools/confirm-registry.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-persona-safety-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const dir = path.join(root,'记忆/人格修订'), agentDir = path.join(root,'agent');
  fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(agentDir);
  const file = path.join(root,'记忆/人格定义.json'), append = path.join(agentDir,'APPEND_SYSTEM.md');
  fs.writeFileSync(file,JSON.stringify(DEFAULT_DEFINITION)); fs.writeFileSync(append,'UNCHANGED');
  const api = createPersonaGovernance({wsRoot:root,agentDir});
  const plan = () => api.prepare('apply',{expectedRevision:api.read().revision,definition:{name:'New'},reason:'test'});
  return {api,plan,file,append,dir};
}
test('persona rejects structurally incomplete or invalid authority instead of filling defaults', t => {
  const f = fixture(t);
  for (const value of [null,[],{}, {name:'Partial',age:20}, {...DEFAULT_DEFINITION,name:123}, {...DEFAULT_DEFINITION,age:'20'}]) {
    const raw = JSON.stringify(value); fs.writeFileSync(f.file,raw);
    assert.ok(f.api.read().problems.length, `must reject ${raw}`);
    assert.throws(f.plan,/读取|定义/);
    assert.equal(fs.readFileSync(f.file,'utf8'),raw);
  }
});
test('persona rejects ambiguous duplicate block markers without touching files', t => {
  const f = fixture(t), original = fs.readFileSync(f.file,'utf8');
  for (const text of [PERSONA_BEGIN, PERSONA_END+PERSONA_BEGIN, `${PERSONA_BEGIN}a${PERSONA_END}${PERSONA_BEGIN}b${PERSONA_END}`]) {
    fs.writeFileSync(f.append,text);
    assert.throws(()=>f.api.commit(f.plan(),'human-confirm:s:c'),/标记/);
    assert.equal(fs.readFileSync(f.append,'utf8'),text); assert.equal(fs.readFileSync(f.file,'utf8'),original);
    assert.equal(f.api.read().history.length,0);
  }
});
test('pending recovery journal and concurrent lock block writes', t => {
  const f = fixture(t), plan = f.plan(), original=fs.readFileSync(f.file,'utf8');
  fs.writeFileSync(path.join(f.dir,'pending.json'),'{}');
  assert.ok(f.api.read().problems.length); assert.throws(f.plan,/读取/);
  fs.unlinkSync(path.join(f.dir,'pending.json'));
  fs.writeFileSync(path.join(f.dir,'write.lock'),'another writer');
  assert.throws(()=>f.api.commit(plan,'human-confirm:s:c'),/锁|修改/);
  assert.equal(fs.readFileSync(f.file,'utf8'),original);
  assert.equal(fs.readFileSync(path.join(f.dir,'write.lock'),'utf8'),'another writer');
});
test('partial write failure restores both files and removes unfinished record', t => {
  const f=fixture(t), plan=f.plan(), original=fs.readFileSync(f.file,'utf8');
  const rename=fs.renameSync; let failed=false;
  t.mock.method(fs,'renameSync',(from,to)=>{
    if(to===f.file && !failed){failed=true; throw new Error('simulated disk failure');}
    return rename(from,to);
  });
  assert.throws(()=>f.api.commit(plan,'human-confirm:s:c'),/disk failure/);
  assert.equal(fs.readFileSync(f.file,'utf8'),original);
  assert.equal(fs.readFileSync(f.append,'utf8'),'UNCHANGED');
  assert.equal(f.api.read().history.length,0); assert.deepEqual(fs.readdirSync(f.dir),[]);
});
test('expired and concurrent persona approvals cannot commit or leak pending requests', async t => {
  const f=fixture(t), sid='persona-timeout';
  const request=createPersonaApproval({api:f.api,registry,sessionExists:s=>s===sid,push(){},timeoutMs:20});
  const body={expectedRevision:f.api.read().revision,definition:{name:'New'},reason:'test',sessionId:sid};
  const waiting=request('apply',body);
  assert.equal((await request('apply',body)).code,'confirmation_pending');
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await waiting).code,'confirmation_denied');
  assert.equal(f.api.read().history.length,0); assert.equal(registry.list().length,0);
});
test('persona route caps request body in megabytes rather than treating megabytes as kilobytes', () => {
  const source=fs.readFileSync(new URL('../../server.mjs',import.meta.url),'utf8');
  assert.ok(source.includes('requestPersonaApproval(action, await readBody(req, 2))'));
});

test('malformed approval payloads return a controlled failure without opening confirmation', async t => {
  const f = fixture(t);
  const request = createPersonaApproval({api:f.api, registry, sessionExists:()=>true, push(){throw new Error('must not confirm');}});
  for (const body of [null, [], 'invalid', 42]) assert.equal((await request('apply',body)).code,'invalid_request');
  assert.equal(f.api.read().history.length,0);
});

test('startup persona sync rejects malformed markers and unreadable existing append', t => {
  const f = fixture(t), agentDir = path.dirname(f.append);
  for (const text of [PERSONA_BEGIN, PERSONA_END+PERSONA_BEGIN, `${PERSONA_BEGIN}a${PERSONA_END}${PERSONA_BEGIN}b${PERSONA_END}`]) {
    fs.writeFileSync(f.append,text);
    assert.equal(syncAppendSystemPersona(DEFAULT_DEFINITION,{agentDir}).ok,false);
    assert.equal(fs.readFileSync(f.append,'utf8'),text);
  }
  const fsMod = {...fs,readFileSync(){throw new Error('unreadable');}};
  assert.equal(syncAppendSystemPersona(DEFAULT_DEFINITION,{agentDir,fsMod}).ok,false);
});

test('startup sync shares governance source and unfinished transaction gate', () => {
  const source=fs.readFileSync(new URL('../../server.mjs',import.meta.url),'utf8');
  const start=source.indexOf('// 人格定义 → 人格化');
  const block=source.slice(start,source.indexOf('// 存量会话 SDK',start));
  assert.ok(block.includes('personaGovernance.read()'));
  assert.ok(block.includes('pd.problems.length'));
  assert.ok(block.includes('write.lock'));
});
