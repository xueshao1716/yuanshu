// 2026-11-19：OpenRouter 出图走 chat/completions + modalities:["image"]（Recraft V4.1 Flash V2 免费档）
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateProviderImage } from '../../engine/media/provider-adapters.mjs';
import { effectiveCapabilities } from '../../shared/model-capabilities.mjs';

test('OpenRouter 出图：请求 chat/completions，画幅换成 aspect_ratio，取 message.images 里的 data URL', async t => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }).on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { images: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAAA' } }] } }] }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const out = await generateProviderImage({ provider: 'openrouter', modelId: 'recraft/recraft-v4.1-flash-v2:free', prompt: '一只猫', size: '1024x1536',
    baseUrl: `http://127.0.0.1:${server.address().port}/api/v1`, key: 'sk-or-test' });
  assert.equal(out, 'data:image/webp;base64,AAAA');
  assert.equal(seen[0].url, '/api/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer sk-or-test');
  assert.deepEqual(seen[0].body.modalities, ['image']);
  assert.equal(seen[0].body.image_config.aspect_ratio, '2:3');
  assert.equal(seen[0].body.messages[0].content, '一只猫');
});

test('Recraft 系列按出图模型识别，不当对话模型', () => {
  const caps = effectiveCapabilities({ id: 'recraft/recraft-v4.1-flash-v2:free' });
  assert.equal(caps.image, true);
  assert.equal(caps.chat, false);
});
