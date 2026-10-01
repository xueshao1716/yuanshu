import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {initFileLock} from '../../engine/file-lock.mjs';

test('one durable background slot covers knowledge and cultivation, foreground wins',async t=>{
  const {createBackgroundAdmission}=await import('../../engine/background-admission.mjs');
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-admission-'));
  initFileLock({dir:path.join(wsRoot,'locks')});t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  let busy=true;
  const a=createBackgroundAdmission({wsRoot,foregroundBusy:()=>busy});
  const b=createBackgroundAdmission({wsRoot});
  assert.equal(await a.acquire('cultivation'),null);busy=false;
  const first=await a.acquire('knowledge');assert.ok(first);
  assert.equal(await b.acquire('cultivation'),null);
  assert.equal(await b.release(first.id),false);
  assert.equal((await b.status()).state,'held');
  assert.equal(await a.release(first.id),true);
  const child=await b.acquire('cultivation');assert.ok(child);
  assert.equal(await a.acquire('knowledge'),null);
  const restarted=createBackgroundAdmission({wsRoot,now:()=>Date.now()+86400000});
  assert.equal(await restarted.acquire('knowledge'),null);
  assert.equal((await restarted.status()).consumer,'cultivation');
  assert.equal(await b.release(child.id),true);
  await assert.rejects(a.acquire('other'),/background_invalid_consumer/);
});

test('production recovery exposes exact abandoned slot and requires host process termination',async t=>{
  const {createBackgroundAdmission}=await import('../../engine/background-admission.mjs');
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-admission-host-'));
  initFileLock({dir:path.join(wsRoot,'locks')});t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    `import {createBackgroundAdmission} from ${JSON.stringify(new URL('../../engine/background-admission.mjs',import.meta.url).href)};
     import {initFileLock} from ${JSON.stringify(new URL('../../engine/file-lock.mjs',import.meta.url).href)};
     initFileLock({dir:${JSON.stringify(path.join(wsRoot,'locks'))}});
     console.log(JSON.stringify(await createBackgroundAdmission({wsRoot:${JSON.stringify(wsRoot)}}).acquire('cultivation')));`],
    {encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,0,child.stderr);
  const slot=JSON.parse(child.stdout.trim()),a=createBackgroundAdmission({wsRoot});
  const status=await a.status();assert.equal(status.id,slot.id);assert.equal(status.recoveryRequired,true);
  assert.equal(await a.reconcile({expectedId:'wrong'}),false);
  assert.equal(await a.reconcile({expectedId:slot.id}),true);
  const active=await a.acquire('knowledge');assert.equal((await a.status()).recoveryRequired,false);
  assert.equal(await a.reconcile({expectedId:active.id}),false);
});

test('recovery needs host termination evidence for the exact durable slot',async t=>{
  const {createBackgroundAdmission}=await import('../../engine/background-admission.mjs');
  const wsRoot=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-admission-recovery-'));
  initFileLock({dir:path.join(wsRoot,'locks')});t.after(()=>fs.rmSync(wsRoot,{recursive:true,force:true}));
  const first=createBackgroundAdmission({wsRoot});
  const slot=await first.acquire('cultivation');
  const untrusted=createBackgroundAdmission({wsRoot});
  assert.equal(typeof untrusted.reconcile,'function');
  assert.equal(await untrusted.reconcile(),false);
  let evidence='unknown';
  const restarted=createBackgroundAdmission({wsRoot,resolveTermination:async observed=>{
    assert.equal(observed.id,slot.id);return evidence;
  }});
  assert.equal(await restarted.reconcile(),false);
  evidence={id:'wrong',terminated:true};assert.equal(await restarted.reconcile(),false);
  evidence={id:slot.id,terminated:true};assert.equal(await restarted.reconcile(),true);
  assert.equal((await restarted.status()).state,'idle');
  assert.ok(await restarted.acquire('knowledge'));
});
