import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { createHistoryApi } from '../../engine/history-api.mjs';

test('rollback audit failure returns explicit recovery warning', async t => {
  const { wsRoot } = fixture(t);
  fs.mkdirSync(path.join(wsRoot, '工程'));
  fs.writeFileSync(path.join(wsRoot, '工程/a.txt'), 'current');
  fs.writeFileSync(path.join(wsRoot, '工程/a.txt.bak'), 'old');
  const original = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, data, ...args) => {
    if (String(data).includes('"kind":"history-rollback"')) throw new Error('audit failure');
    return original(file, data, ...args);
  });
  const api = createHistoryApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  const result = await api.rollback(null, { backup: '工程/a.txt.bak' });
  assert.equal(result.status, 500);
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.readFileSync(path.join(wsRoot, '工程/a.txt'), 'utf8'), 'old');
  assert.ok(fs.readdirSync(path.join(wsRoot, '工程')).some(n => n.startsWith('a.txt.bak-rollback-')));
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-review-txn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wsRoot = path.join(root, 'workspace');
  fs.mkdirSync(wsRoot);
  const api = createPendingApi({ wsRoot, json: (_, status, body) => ({ status, ...body }) });
  return { root, wsRoot, api };
}

test('queue junction is rejected without writing outside workspace', async t => {
  const { root, wsRoot, api } = fixture(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(wsRoot, '工程'));
  const link = path.join(wsRoot, '工程/待审');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal((await api.create(null, { target: '工程/a.txt', content: 'draft' })).status, 500);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal((await api.list(null)).status, 500);
  } finally { fs.unlinkSync(link); }
});

test('audit hardlink is rejected before proposal or target write', async t => {
  const { root, wsRoot, api } = fixture(t);
  const outside = path.join(root, 'audit.txt'); fs.writeFileSync(outside, 'untouched');
  fs.mkdirSync(path.join(wsRoot, '记忆'));
  fs.linkSync(outside, path.join(wsRoot, '记忆/授权记录.jsonl'));
  const result = await api.create(null, { target: '工程/a.txt', content: 'draft' });
  assert.equal(result.status, 500);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(wsRoot, '工程/a.txt')), false);
  assert.equal((await api.list(null)).items.length, 0);
});

test('linked queue entries are not read or accepted', async t => {
  const { root, wsRoot, api } = fixture(t);
  const outside = path.join(root, 'record.json');
  fs.writeFileSync(outside, JSON.stringify({ id: 'pforged', status: 'pending', target: '工程/a.txt', content: 'draft' }));
  fs.mkdirSync(path.join(wsRoot, '工程/待审'), { recursive: true });
  fs.linkSync(outside, path.join(wsRoot, '工程/待审/pforged.json'));
  assert.equal((await api.get(null, 'pforged')).status, 500);
  assert.equal((await api.list(null)).items.length, 0);
});

test('completion audit failure leaves a visible nonreplayable recovery record', async t => {
  const { wsRoot, api } = fixture(t);
  const created = await api.create(null, { target: '工程/a.txt', content: 'draft' });
  const original = fs.appendFileSync;
  t.mock.method(fs, 'appendFileSync', (file, data, ...args) => {
    if (String(data).includes('"kind":"pending-accept"')) throw new Error('simulated audit failure');
    return original(file, data, ...args);
  });
  const result = await api.accept(null, created.id);
  assert.equal(result.status, 500);
  assert.equal(result.recoveryRequired, true);
  assert.equal(fs.readFileSync(path.join(wsRoot, '工程/a.txt'), 'utf8'), 'draft');
  assert.equal((await api.get(null, created.id)).item.status, 'needs_recovery');
  assert.equal((await api.list(null)).items[0].status, 'needs_recovery');
  assert.equal((await api.accept(null, created.id)).status, 409);
});

test('simultaneous acceptance cannot apply a proposal twice', async t => {
  const { api } = fixture(t);
  const created = await api.create(null, { target: '工程/a.txt', content: 'draft' });
  const results = await Promise.all([api.accept(null, created.id), api.accept(null, created.id)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
