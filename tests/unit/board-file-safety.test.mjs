import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPendingApi } from '../../engine/pending-api.mjs';
import { createHistoryApi } from '../../engine/history-api.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }));
  const wsRoot = path.join(dir, 'workspace'); fs.mkdirSync(wsRoot);
  const json = (_, status, body) => ({ status, ...body });
  const write = (rel, text) => { const f = path.join(wsRoot, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  return { dir, wsRoot, write, pending: createPendingApi({ wsRoot, json }), history: createHistoryApi({ wsRoot, json }) };
}

for (const target of ['工程/.GIT/config', '工程/NODE_MODULES/a.js', '记忆/授权记录.JSONL', '记忆/人格定义.JSON', '记忆/宪法.JSON']) {
  test(`case aliases of protected records are refused: ${target}`, async t => {
    const f = fixture(t);
    assert.equal((await f.pending.create(null, { target, content: 'x' })).status, 400);
  });
}

for (const target of ['../outside.txt', 'C:/outside.txt', '/outside.txt', '工程/../记忆/人格定义.json', '工程/待审/forged.json', '记忆/授权记录.jsonl', '工程/a.txt:stream', '工程/.git/config']) {
  test(`pending refuses unsafe target ${target}`, async t => {
    const f = fixture(t);
    const r = await f.pending.create(null, { target, content: 'x' });
    assert.equal(r.status, 400);
  });
}
test('pending rejects changed baseline and preserves newer content', async t => {
  const f = fixture(t); const file = f.write('工程/demo.txt', 'old');
  const r = await f.pending.create(null, { target: '工程/demo.txt', content: 'proposal' });
  fs.writeFileSync(file, 'newer');
  assert.equal((await f.pending.accept(null, r.id)).status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer');
});
test('pending rejects a newly appeared target', async t => {
  const f = fixture(t);
  const r = await f.pending.create(null, { target: '工程/new.txt', content: 'proposal' });
  f.write('工程/new.txt', 'someone else');
  assert.equal((await f.pending.accept(null, r.id)).status, 409);
});
test('accept keeps unique backups, audit and prevents replay', async t => {
  const f = fixture(t); f.write('工程/demo.txt', 'one');
  const a = await f.pending.create(null, { target: '工程/demo.txt', content: 'two' });
  const ar = await f.pending.accept(null, a.id); assert.equal(ar.status, 200);
  const b = await f.pending.create(null, { target: '工程/demo.txt', content: 'three' });
  const br = await f.pending.accept(null, b.id); assert.equal(br.status, 200);
  assert.notEqual(ar.backup, br.backup);
  assert.equal(fs.readFileSync(path.join(f.wsRoot, ar.backup), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(f.wsRoot, br.backup), 'utf8'), 'two');
  assert.ok(fs.existsSync(path.join(f.wsRoot, '记忆/授权记录.jsonl')));
  assert.equal((await f.pending.accept(null, a.id)).status, 409);
});
test('legacy proposals require regeneration, invalid IDs cannot load outside queue', async t => {
  const f = fixture(t); f.write('工程/待审/plegacy.json', JSON.stringify({ id:'plegacy', target:'工程/a.txt', status:'pending', content:'x' }));
  assert.equal((await f.pending.accept(null, 'plegacy')).status, 409);
  f.write('工程/escape.json', '{}');
  assert.equal((await f.pending.get(null, '../escape')).status, 404);
});
test('symlink parents of missing files cannot escape workspace', async t => {
  const f = fixture(t); const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(f.wsRoot, '工程'));
  fs.symlinkSync(outside, path.join(f.wsRoot, '工程/link'), process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.equal((await f.pending.create(null, { target:'工程/link/new.txt', content:'x' })).status, 400); }
  finally { fs.unlinkSync(path.join(f.wsRoot, '工程/link')); }
});
test('large diff has bounded algorithm and marks truncation', async t => {
  const f = fixture(t); f.write('工程/large.txt', 'a\n'.repeat(12000));
  const r = await f.pending.create(null, { target:'工程/large.txt', content:'b\n'.repeat(12000) });
  const detail = await f.pending.get(null, r.id);
  assert.equal(detail.item.diff.truncated, true);
  assert.ok(detail.item.diff.text.length < 21000);
});
test('history target parsing only touches basename and returns relative paths', async t => {
  const f = fixture(t); f.write('工程/project.bak-old/demo.txt.bak-one', 'old');
  f.write('工程/project.bak-old/demo.txt', 'new');
  const list = await f.history.list(null);
  assert.equal(list.backups[0].target.replaceAll('\\','/'), '工程/project.bak-old/demo.txt');
  assert.equal(path.isAbsolute(list.backups[0].backup), false);
  const result = await f.history.rollback(null, { backup:list.backups[0].backup });
  assert.equal(result.status, 200);
  assert.equal(fs.readFileSync(path.join(f.wsRoot,'工程/project.bak-old/demo.txt'),'utf8'), 'old');
});
test('history rejects traversal and protected targets', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.dir,'outside.txt.bak'), 'x');
  f.write('记忆/人格定义.json.bak-old', 'x');
  for (const backup of ['../outside.txt.bak', '记忆/人格定义.json.bak-old']) {
    assert.equal((await f.history.rollback(null, { backup })).status, 400);
  }
});
