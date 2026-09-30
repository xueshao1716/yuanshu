import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {controlFixture, draft, enabledPolicy} from '../helpers/cultivation-fixture.mjs';
import {reviewAtomicWrite} from '../../engine/review-file-safety.mjs';
import {withFileLock} from '../../engine/file-lock.mjs';

test('partial registration remains visible and retries repair only the same child intent', async t => {
  let failChild = true;
  const f = await controlFixture(t, {storage: {atomicWrite: (file, text) => {
    if (failChild && path.basename(file) === 'state.json') throw new Error('fixture_child_write_failure');
    reviewAtomicWrite(file, text);
  }}});
  await f.execute(f.command('policy.set', {policy: enabledPolicy()}));
  const d = await f.execute(f.command('design.submit', {design: draft()}), 'mother');
  const c = f.command('agent.register', {designId: d.result.id});
  await assert.rejects(f.execute(c, 'mother'), /fixture_child_write_failure/);
  const saved = f.controls.read();
  assert.equal(saved.data.agents.length, 1);
  assert.equal(saved.data.intents.length, 1);
  assert.equal(f.store.read(saved.data.agents[0].id).revision, 0);
  failChild = false;
  const receipt = await f.execute(c, 'mother');
  assert.equal(receipt.result.id, saved.data.agents[0].id);
  assert.equal(f.store.read('control').revision, saved.revision);
  assert.equal(f.store.read(receipt.result.id).revision, 1);
  await f.controls.reconcile();
  assert.equal(f.store.read(receipt.result.id).revision, 1);
});

test('lock-time asset check uses the actual registered UUID, not another generated identity', async t => {
  const seen = [];
  const f = await controlFixture(t, {controls: {verifyAsset: b => {seen.push(b.agentId); return true;}}});
  await f.execute(f.command('policy.set', {policy: enabledPolicy()}));
  const design = draft(); design.voice.asset = {id: 'voice-fixture', version: 1};
  const d = await f.execute(f.command('design.submit', {design}), 'mother');
  const r = await f.execute(f.command('agent.register', {designId: d.result.id}), 'mother');
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(id => id === r.result.id));
});

test('revocation while queued prevents control write; concurrent identical requests commit once', async t => {
  const f = await controlFixture(t), c = f.command('design.submit', {design: draft()});
  let release, entered;
  const gate = new Promise(r => {release = r;}), ready = new Promise(r => {entered = r;});
  const held = withFileLock(path.join(f.root, '工程', '智能体培养', 'control.json'), async () => {entered(); await gate;});
  await ready;
  const pending = f.execute(c, 'mother');
  f.mother.active = false; release(); await held;
  await assert.rejects(pending, /identity_denied/);
  assert.equal(f.store.read('control').revision, 0);
  f.mother.active = true;
  const [a, b] = await Promise.all([f.execute(c, 'mother'), f.execute(c, 'mother')]);
  assert.deepEqual(a, b);
  assert.equal(f.store.read('control').revision, 1);
});

test('separate processes competing on same version cannot lose a committed write', async t => {
  const f = await controlFixture(t);
  const storageUrl = pathToFileURL(path.resolve('engine/cultivation/storage.mjs')).href;
  const lockUrl = pathToFileURL(path.resolve('engine/file-lock.mjs')).href;
  const script = `import {createCultivationStorage} from ${JSON.stringify(storageUrl)};
    import {initFileLock} from ${JSON.stringify(lockUrl)};
    initFileLock({dir: process.argv[2]});
    const store = createCultivationStorage({wsRoot: process.argv[1]});
    try { await store.commit('control', {expectedRevision:0, actor:'fixture-process', action:'race', data:{value:process.pid}}); console.log('committed'); }
    catch(e) {if(e.message!=='cultivation_revision_conflict') throw e;console.log('conflict');}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.root, path.join(f.root, 'locks')],
      {windowsHide: true, timeout: 15000});
    let stdout = '', stderr = '';
    child.stdout.on('data', v => {stdout += v;}); child.stderr.on('data', v => {stderr += v;});
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
  });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.sort(), ['committed', 'conflict']);
  assert.equal(f.store.read('control').revision, 1);
  assert.ok(fs.existsSync(path.join(f.root, '工程', '智能体培养', 'control.json')));
});
