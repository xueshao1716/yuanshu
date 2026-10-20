import test from 'node:test';
import assert from 'node:assert/strict';
import { isTextCapableModel } from '../../engine/model-router.mjs';

// 2026-10-20 真机事故：自我反思被路由到 agnes-video-2.5-flash → HTTP 400「is a video model」。
test('媒体模型不能干文本活', () => {
  const media = [
    'agnes-video-2.5-flash', 'gpt-image-1', 'dall-e-3', 'seedance-video', 'qwen-tts',
    'whisper-asr', 'text-embedding-3-small', 'bge-reranker-v2', 'multi-voice',
  ];
  for (const id of media) assert.equal(isTextCapableModel({ id }), false, id);
});

test('文本模型照常通过（不能误伤）', () => {
  const text = [
    'glm-5.3-flash', 'agnes-2.5-flash', 'agnes-3.0-flash', 'step-5-preview',
    'deepseek-chat', 'claude-sonnet-4', 'gemini-3.5-flash', 'sensenova-flash-lite',
    'mimo-v2.5', 'llama-3.1-8b', 'gpt-4o-mini',
  ];
  for (const id of text) assert.equal(isTextCapableModel({ id }), true, id);
});

test('空值不让崩', () => {
  assert.equal(isTextCapableModel(null), false);
  assert.equal(isTextCapableModel({}), false);
  assert.equal(isTextCapableModel({ id: '' }), false);
});
