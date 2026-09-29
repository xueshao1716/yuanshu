import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from '../../engine/run-store.mjs';

function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-activity-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, store: createRunStore({ rootDir }) };
}

test('activity observation is async, compact, fresh and detached from callers', async t => {
  const { rootDir, store } = fixture(t);
  assert.equal(typeof store.listActivity, 'function', '缺少非阻塞状态观测入口');
  const run = store.create({ sessionId: 'mine', clientRequestId: 'one', message: 'private' });
  const pending = store.listActivity();
  assert.equal(typeof pending.then, 'function');
  const first = await pending;
  assert.deepEqual(first, [{ id: run.id, sessionId: 'mine', status: 'queued' }]);
  first[0].status = 'completed';
  assert.equal((await store.listActivity())[0].status, 'queued');
  store.update(run.id, { status: 'completed' });
  assert.deepEqual(await store.listActivity(), []);
  const external = createRunStore({ rootDir });
  external.update(run.id, { status: 'recovering' });
  assert.equal((await store.listActivity())[0].status, 'recovering');
  const other = external.create({ sessionId: 'other', clientRequestId: 'two' });
  assert.equal((await store.listActivity()).length, 2);
  fs.unlinkSync(path.join(rootDir, 'runs', `${other.id}.json`));
  assert.equal((await store.listActivity()).length, 1);
});

test('unchanged history is not reread and unreadable observations fail closed', async t => {
  const { rootDir, store } = fixture(t);
  assert.equal(typeof store.listActivity, 'function');
  const run = store.create({ sessionId: 'mine', clientRequestId: 'one' });
  store.update(run.id, { status: 'completed' });
  await store.listActivity();
  const original = fs.promises.readFile;
  let reads = 0;
  t.mock.method(fs.promises, 'readFile', async (...args) => { reads++; return original(...args); });
  await Promise.all([store.listActivity(), store.listActivity()]);
  assert.equal(reads, 0, '重复轮询不应重新解码历史任务正文');
  fs.writeFileSync(path.join(rootDir, 'runs', `${run.id}.json`), '{bad');
  await assert.rejects(store.listActivity());
  assert.throws(() => store.readAdmissionSnapshot(), '准入依旧直接读取可靠磁盘记录');
  fs.writeFileSync(path.join(rootDir, 'runs', `${run.id}.json`), JSON.stringify({ ...run, status: 'running' }));
  assert.equal((await store.listActivity())[0].status, 'running');
});

test('cold observation yields to the event loop instead of synchronously scanning history', async t => {
  const { rootDir, store } = fixture(t);
  assert.equal(typeof store.listActivity, 'function');
  for (let i = 0; i < 32; i++) fs.writeFileSync(path.join(rootDir, 'runs', `${i}.json`), JSON.stringify({ id: `${i}`, sessionId: 's', status: 'completed', history: 'x'.repeat(10000) }));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  assert.deepEqual(await store.listActivity(), []);
  assert.equal(yielded, true);
});
