import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

async function fixture() {
  const url = new URL('../../frontend/src/lib/incremental-speech.mjs', import.meta.url);
  assert.ok(fs.existsSync(url), 'incremental reader exists');
  const { createIncrementalSpeech } = await import(url);
  const chunks = [], events = [], timers = new Map(); let timerId = 0;
  const output = { begin: id => events.push(['begin', id]), append: text => chunks.push(text), finish: () => events.push(['finish']), stop: () => events.push(['stop']) };
  const reader = createIncrementalSpeech({ output, schedule: fn => { timers.set(++timerId, fn); return timerId; }, cancel: id => timers.delete(id) });
  return { reader, chunks, events, tick: () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); } };
}
test('first sentence plays before completion; snapshots and finalization do not repeat it', async () => {
  const { reader, chunks, events } = await fixture();
  reader.update('a', '你好，这是第一句话。后面');
  assert.deepEqual(chunks, ['你好，这是第一句话。']);
  reader.update('a', '你好，这是第一句话。后面');
  reader.finish('a', '你好，这是第一句话。后面是尾句');
  assert.deepEqual(chunks, ['你好，这是第一句话。', '后面是尾句']);
  reader.finish('a', '你好，这是第一句话。后面是尾句');
  assert.equal(events.filter(e => e[0] === 'finish').length, 1);
});
test('short timer flushes incomplete prose; code and split markdown never leak to speech', async () => {
  const { reader, chunks, tick } = await fixture();
  reader.update('a', '先说一点内容没有标点'); tick();
  reader.update('a', '先说一点内容没有标点。```js\nsecret();'); tick();
  reader.update('a', '先说一点内容没有标点。```js\nsecret();\n```\n接着[查看'); tick();
  reader.finish('a', '先说一点内容没有标点。```js\nsecret();\n```\n接着[查看](https://example.com)。');
  assert.ok(chunks[0].includes('先说一点内容')); assert.ok(!chunks.join('').includes('secret'));
  assert.ok(!chunks.join('').includes('https')); assert.equal(chunks.join('').replace(/\s/g, ''), '先说一点内容没有标点。接着查看。');
});
test('stop tombstones this reply; rewrites cancel; next reply can start', async () => {
  const { reader, chunks, events } = await fixture();
  reader.update('a', '第一句。'); reader.stop();
  reader.update('a', '第一句。后面。'); reader.finish('a', '第一句。后面。');
  assert.deepEqual(chunks, ['第一句。']);
  reader.update('b', '下一轮。'); reader.update('b', '重写的答案。');
  assert.deepEqual(chunks, ['第一句。', '下一轮。']);
  assert.ok(events.some(e => e[0] === 'stop'));
});
test('long unpunctuated prose is bounded without losing surrogate pairs', async () => {
  const { reader, chunks } = await fixture();
  const text = '你好😀'.repeat(200); reader.finish('a', text);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(s => s.length <= 160));
  assert.ok(chunks.every(s => !/[\uD800-\uDBFF]$/.test(s)));
});
test('inline code does not swallow following prose, including split delimiters', async () => {
  const { reader, chunks, tick } = await fixture();
  reader.update('a', '先看 `secret'); tick();
  reader.finish('a', '先看 `secret()`，然后继续说明。');
  assert.equal(chunks.join('').replace(/\s/g, ''), '先看，然后继续说明。');
});
test('restored replies stay silent even when their replay arrives after opt-in', async () => {
  const { reader, chunks } = await fixture();
  assert.equal(typeof reader.skip, 'function');
  reader.skip('old'); reader.update('old', '恢复的旧正文。'); reader.finish('old', '恢复的旧正文。后续。');
  assert.deepEqual(chunks, []);
  reader.update('new', '新回复。'); assert.deepEqual(chunks, ['新回复。']);
});
test('ChatArea feeds live正文 and completes existing audio instead of restarting full text', () => {
  const source = fs.readFileSync(new URL('../../frontend/src/components/ChatArea.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('speech.updateReply(')); assert.ok(source.includes('speech.finishReply('));
  assert.ok(!source.includes('speech.speak(savedId, s.text)'));
  assert.ok(source.includes('speech.skipReply(record.assistantMessageId)'));
  const message = fs.readFileSync(new URL('../../frontend/src/components/Message.tsx', import.meta.url), 'utf8');
  assert.ok(message.includes('<SpeechControls live'));
  const sendBody = source.slice(source.indexOf('const send = async'), source.indexOf('// 失败重试'));
  assert.ok(sendBody.includes('speech.stop()'), 'new sends stop the preceding reply immediately');
});
