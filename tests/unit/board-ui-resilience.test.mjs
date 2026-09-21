import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = file => fs.readFileSync(new URL('../../frontend/src/' + file, import.meta.url), 'utf8');
test('recovery proposals cannot be replayed and failures refresh the queue', () => {
  const src = read('components/PendingChanges.tsx');
  assert.equal(src.split('\n').filter(line => line.includes('disabled={busy') && line.includes("it.status !== 'pending'")).length, 2);
  assert.ok(src.includes('待恢复'));
  assert.ok(src.split('\n').some(line => line.includes('finally') && line.includes('mutate()')));
});
test('unknown workflow versions are not interpreted as V20', () => {
  const src = read('components/TeamRunView.tsx');
  assert.equal(src.includes('此记录未提供 V20.0'), false);
  assert.ok(src.includes('未标注流程版本'));
});
for (const file of ['pages/Board.tsx', 'components/PendingChanges.tsx', 'components/HistoryPanel.tsx', 'components/TeamRunView.tsx']) {
  test(`${file} uses shared API and displays errors`, () => {
    const src = read(file);
    assert.ok(!src.includes('fetch('));
    assert.ok(!src.includes('localStorage'));
    assert.ok(src.includes('error') || src.includes('Error'));
  });
}
for (const file of ['components/PendingChanges.tsx', 'components/HistoryPanel.tsx']) {
  test(`${file} prevents repeated actions and renders action failures`, () => {
    const src = read(file);
    assert.ok(src.includes('disabled={busy'));
    assert.ok(src.includes('role="alert"'));
    assert.ok(src.includes('catch ('));
    assert.ok(src.includes('finally'));
  });
}
test('team reflects actual phase status, timestamp and missing checklist', () => {
  const src = read('components/TeamRunView.tsx');
  assert.ok(src.includes('s.status'));
  assert.ok(src.includes('run.createdAt'));
  assert.ok(src.includes('正在读取'));
  assert.ok(src.includes("passed ?? '—'"));
  assert.ok(!src.includes('**模型真实产出**'));
});
test('overview guards failed bootstrap and sorts recent deliveries', () => {
  const src = read('pages/Board.tsx');
  assert.ok(src.includes('bootError'));
  assert.ok(src.includes('__error'));
  assert.ok(src.includes('health?.status'));
  assert.ok(src.includes('.sort(') && src.includes('b.mtime'));
});
