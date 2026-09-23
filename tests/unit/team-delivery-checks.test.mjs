import test from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../../engine/team-delivery-checks.mjs').catch(() => ({}));
test('timed speech detects known overrun without counting captions or instructions', () => {
  assert.equal(typeof mod.inspectTimedSpeech, 'function');
  const result = mod.inspectTimedSpeech('0—3秒；口播：“这家单份能否吃饱？”\n字幕：【实测填写：售价、等待、位置等信息】\n3—5秒；口播：“先来看看这家店的菜单到底有些什么”。');
  assert.equal(result.checked, 2);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /3.*5.*口播.*超/);
});
test('placeholders are not spoken field names and unchecked text is not claimed valid', () => {
  const result = mod.inspectTimedSpeech('0-3秒；口播：“实付【实测填写：数字金额】元。”');
  assert.equal(result.issues.length, 0);
  assert.equal(result.unresolved, 1);
  assert.equal(mod.inspectTimedSpeech('一份无时间轴的普通策划').checked, 0);
});
test('supports multiline speech and rejects nonpositive shot duration', () => {
  const result = mod.inspectTimedSpeech('0–2秒\n画面：菜单\n口播："这句话显然超过两秒所能容纳的长度"\n2—2秒，口播：“好。”');
  assert.equal(result.checked, 2);
  assert.equal(result.issues.length, 2);
});
test('English words are not counted as individual letters and notes do not belong to last shot', () => {
  const result = mod.inspectTimedSpeech('0—3秒；口播：“Try this small local cafe.”\n\n【拍摄说明】\n口播：“这里只是长篇补充说明不属于最后一个镜头的台词。”');
  assert.equal(result.checked, 1);
  assert.deepEqual(result.issues, []);
});
