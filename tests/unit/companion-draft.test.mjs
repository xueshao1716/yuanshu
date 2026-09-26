import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueDraft, takeDraft, mergeDraft } from '../../frontend/src/components/xiaoyu/companion-draft.mjs';
const storage = () => { const values = new Map(); return { setItem: (k,v) => values.set(k,v), getItem: k => values.get(k) ?? null, removeItem: k => values.delete(k) }; };
test('explicit handoff is session scoped, one-shot and expires', () => {
  const s = storage();
  assert.equal(queueDraft(s, 'one', '任务', 100), true);
  assert.equal(takeDraft(s, 'two', 101), null);
  assert.equal(takeDraft(s, 'one', 101), '任务');
  assert.equal(takeDraft(s, 'one', 101), null);
  queueDraft(s, 'one', '旧任务', 100);
  assert.equal(takeDraft(s, 'one', 400000), null);
});
test('handoff preserves existing draft and rejects empty or oversized input', () => {
  assert.equal(mergeDraft('已有草稿', '新任务'), '已有草稿\n新任务');
  assert.equal(mergeDraft('', '新任务'), '新任务');
  for (const text of ['', ' ', 'x'.repeat(501), null]) assert.equal(queueDraft(storage(), 'one', text, 100), false);
  assert.equal(queueDraft(storage(), null, 'hello', 100), false);
});
