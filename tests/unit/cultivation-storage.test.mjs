// tests/unit/cultivation-storage.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {initFileLock, withFileLock} from '../../engine/file-lock.mjs';
import {reviewAtomicWrite} from '../../engine/review-file-safety.mjs';
import {createCultivationStorage} from '../../engine/cultivation/storage.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-cultivation-storage-'));
  const a = path.join(temp, 'a'), b = path.join(temp, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  initFileLock({dir: path.join(temp, 'locks')});
  const links = [];
  t.after(() => {
    // Unlink owned junctions before their targets become dangling on Windows.
    for (const link of links.reverse()) {
      assert.ok(path.relative(temp, link) && !path.relative(temp, link).startsWith('..'));
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      fs.unlinkSync(link);
    }
    fs.rmSync(temp, {recursive: true, force: true});
  });
  return {temp, a, b, links};
}
const change = (data, expectedRevision = 0) => ({expectedRevision, data,
  actor: 'service:fixture', action: 'saved'});
const fileFor = (root, id) => path.join(root, '工程', '智能体培养', 'agents', id, 'state.json');

test('空读取不写盘；孩子、工作区和返回对象不串；重启保持状态', async t => {
  const {a, b} = fixture(t), one = randomUUID(), two = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  assert.equal(store.read(one).revision, 0);
  assert.equal(store.read('control').revision, 0);
  assert.deepEqual(fs.readdirSync(a), []);
  const media = {appearance: {assetId: 'fixture-a'}, voice: {voiceId: 'fixture-voice'},
    layers: {temporary: {expression: 'serious'}, stable: {}, knowledgeRefs: []}, status: 'paused'};
  const saved = await store.commit(one, change(media));
  saved.data.voice.voiceId = 'mutated';
  assert.equal(store.read(one).data.voice.voiceId, 'fixture-voice');
  assert.deepEqual(store.read(two).data, {});
  assert.deepEqual(createCultivationStorage({wsRoot: b}).read(one).data, {});
  const restarted = createCultivationStorage({wsRoot: a});
  assert.equal(restarted.read(one).data.status, 'paused');
  assert.equal(restarted.read(one).audit.length, 1);
  assert.equal(fs.existsSync(path.join(a, '记忆')), false);
  const control = await store.commit('control', change({enabled: false}));
  assert.equal(control.scope, 'control');
  assert.equal(restarted.read('control').data.enabled, false);
  assert.equal(restarted.read(one).revision, 1);
  fs.mkdirSync(path.dirname(fileFor(a, two)), {recursive: true});
  fs.copyFileSync(fileFor(a, one), fileFor(a, two));
  assert.throws(() => restarted.read(two), /invalid_record/);
  const copied = fileFor(b, one);
  fs.mkdirSync(path.dirname(copied), {recursive: true});
  fs.copyFileSync(fileFor(a, one), copied);
  assert.throws(() => createCultivationStorage({wsRoot: b}).read(one), /invalid_record/);
});

test('同版本并发只能一次成功；失败不会写状态或追加审计', async t => {
  const {a} = fixture(t), id = randomUUID();
  const first = createCultivationStorage({wsRoot: a});
  const second = createCultivationStorage({wsRoot: a});
  const results = await Promise.allSettled([
    first.commit(id, change({value: 1})), second.commit(id, change({value: 2}))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /revision_conflict/);
  const before = fs.readFileSync(fileFor(a, id), 'utf8');
  const brokenWriter = createCultivationStorage({wsRoot: a,
    atomicWrite: () => {throw new Error('fixture_write_failure');}});
  await assert.rejects(brokenWriter.commit(id, change({value: 3}, 1)), /fixture_write_failure/);
  assert.equal(fs.readFileSync(fileFor(a, id), 'utf8'), before);
  assert.equal(first.read(id).audit.length, 1);
  await assert.rejects(first.commit(id, change({value: 4}, 0)), /revision_conflict/);
  assert.equal(fs.readFileSync(fileFor(a, id), 'utf8'), before);
});

test('拒绝路径、链接、损坏 JSON，不能自动重建覆盖', async t => {
  const {temp, a, b, links} = fixture(t), id = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  assert.throws(() => store.read('../mother'), /invalid_scope/);
  await store.commit(id, change({note: 'safe'}));
  const file = fileFor(a, id);
  fs.writeFileSync(file, '{broken fixture');
  assert.throws(() => store.read(id), /state_unreadable/);
  await assert.rejects(store.commit(id, change({note: 'overwrite'}, 1)), /state_unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken fixture');
  fs.writeFileSync(file, ' '.repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => store.read(id), /state_unreadable/);
  await assert.rejects(store.commit(id, change({note: 'overwrite'}, 1)), /state_unreadable/);
  assert.equal(fs.statSync(file).size, 2 * 1024 * 1024 + 1);
  const linkedRoot = path.join(temp, 'linked-root');
  fs.symlinkSync(b, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(linkedRoot);
  assert.throws(() => createCultivationStorage({wsRoot: linkedRoot}), /path_denied/);
  const inner = path.join(b, '工程');
  fs.symlinkSync(a, inner, process.platform === 'win32' ? 'junction' : 'dir');
  links.push(inner);
  assert.throws(() => createCultivationStorage({wsRoot: b}).read('control'), /链接/);
});

test('写入前拒绝过大记录；共享硬链接拒绝读取', async t => {
  const {temp, a} = fixture(t), id = randomUUID();
  let writes = 0;
  const store = createCultivationStorage({wsRoot: a, atomicWrite: (file, text) => {
    writes++; reviewAtomicWrite(file, text);
  }});
  const huge = Object.fromEntries(Array.from({length: 100}, (_, i) => [`field${i}`, 'x'.repeat(30000)]));
  await assert.rejects(store.commit(id, change(huge)), /storage_full/);
  assert.equal(writes, 0);
  assert.equal(store.read(id).revision, 0);
  await store.commit(id, change({note: 'small'}));
  fs.linkSync(fileFor(a, id), path.join(temp, 'duplicate.json'));
  assert.throws(() => store.read(id), /链接/);
  await assert.rejects(store.commit(id, change({note: 'overwrite'}, 1)), /链接/);
});

test('提交不能通过预先复制静默丢弃非法 payload', async t => {
  const {a} = fixture(t), id = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  let getterRuns = 0;
  const accessor = Object.defineProperty({}, 'value', {enumerable: true,
    get() { getterRuns++; return 'side effect'; }});
  const hidden = Object.defineProperty({}, 'value', {value: 'not serialized'});
  for (const data of [{[Symbol('hidden')]: true}, hidden, accessor])
    await assert.rejects(store.commit(id, change(data)), /invalid_payload/);
  assert.equal(getterRuns, 0);
  assert.equal(store.read(id).revision, 0);
  assert.deepEqual(fs.readdirSync(a), []);
});

test('排队后调用方修改输入，不改变本次落盘快照', async t => {
  const {a} = fixture(t), id = randomUUID();
  const store = createCultivationStorage({wsRoot: a});
  let release, entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const blocker = withFileLock(fileFor(a, id), async () => { entered(); await held; });
  await started;
  const input = change({nested: {note: 'original'}});
  const pending = store.commit(id, input);
  input.data.nested.note = 'mutated';
  input.actor = 'mutated';
  release();
  await blocker;
  const saved = await pending;
  assert.equal(saved.data.nested.note, 'original');
  assert.equal(saved.audit[0].actor, 'service:fixture');
  assert.equal(store.read(id).data.nested.note, 'original');
});
