import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageAdapter, createNovelAdapter, createVideoAdapter } from '../../engine/story/adapters.mjs';

test('image adapter returns a normalized artifact result', async () => {
  const adapter = createImageAdapter({ generateImage: async () => 'data:image/png;base64,aGk=', saveArtifact: async () => '/signed/image.png' });
  const result = await adapter.generate({ prompt: '电影感车站', model: { provider: 'p', id: 'm' }, seed: 42 });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.url, '/signed/image.png');
  assert.equal(result.output.type, 'image');
});

test('novel adapter preserves draft text as a controllable artifact', async () => {
  let received;
  const adapter = createNovelAdapter({ directChat: async (_model, _prompt, _history, opts) => { received = opts; return { text: '她在雨里停下。' }; } });
  const result = await adapter.generate({ prompt: '写一段告别', model: { provider: 'p', id: 'm' } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.text, '她在雨里停下。');
  assert.equal(result.output.type, 'text');
  assert.equal('thinking' in received, false);
});

test('video adapter normalizes a completed video and saves it', async () => {
  const adapter = createVideoAdapter({ generateVideo: async () => ({ video: 'https://cdn.example/video.mp4' }), saveArtifact: async () => '/signed/video.mp4' });
  const result = await adapter.generate({ prompt: '车站告别', model: { provider: 'p', id: 'm' }, params: { duration: 5 } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.output.type, 'video');
  assert.equal(result.output.url, '/signed/video.mp4');
});
