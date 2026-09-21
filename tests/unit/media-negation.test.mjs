import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMediaIntents, mediaAwarePrompt } from '../../engine/media-api.mjs';

test('draft revision with explicit media refusal does not start media or claim generation', () => {
  const message = '继续刚才天团的雨夜书店草稿，用 read 读取草稿，用 write 保存修订稿。去掉重复的 ss，补齐每镜声音提示。不生图，不生成视频，不发送。';
  assert.deepEqual(detectMediaIntents(message), []);
  assert.equal(mediaAwarePrompt(message, []), message);
});

test('bare Chinese negation is respected for image, speech and video', () => {
  for (const message of ['不生成图片，只改文案', '不配音，只写台词', '不朗读，只校对', '不做视频，只改分镜', '不再生成视频', '不出短片']) {
    assert.deepEqual(detectMediaIntents(message), [], message);
  }
});

test('refusing one medium does not suppress an explicitly requested other medium', () => {
  assert.deepEqual(detectMediaIntents('生成图片，不配音').map(i => i.type), ['image']);
  assert.deepEqual(detectMediaIntents('不生成图片，生成视频').map(i => i.type), ['video']);
  assert.deepEqual(detectMediaIntents('不用配音，生成图片').map(i => i.type), ['image']);
  assert.deepEqual(detectMediaIntents('不错，生成视频').map(i => i.type), ['video']);
});
