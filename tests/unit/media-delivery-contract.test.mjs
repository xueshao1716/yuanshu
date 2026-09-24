import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as embed from '../../engine/media-embed.mjs';
import { createMediaToolExecutor, MEDIA_TOOL_SCHEMAS } from '../../engine/media-channels.mjs';
import { detectMediaIntents } from '../../engine/media-api.mjs';

test('tool media: old paths from read/bash never become attachments; explicit successful media has provenance', () => {
  assert.equal(typeof embed.explicitToolMedia, 'function');
  for (const name of ['read', 'bash']) {
    assert.equal(embed.explicitToolMedia({ text: '生成物/视频/旧酒吧.mp4 生成物/图片/旧香水.png' }, { id: 't1', name }), null);
  }
  const out = { text: 'ok', media: { type: 'image', url: '/new.png' } };
  assert.deepEqual(embed.explicitToolMedia(out, { id: 't2', name: 'generate_image' }), {
    type: 'image', url: '/new.png', source: 'tool', toolCallId: 't2', toolName: 'generate_image',
  });
  assert.equal(embed.explicitToolMedia({ ...out, isError: true }, { id: 't2' }), null);
});

test('image tool exposes real size and aspect_ratio parameters', () => {
  const props = MEDIA_TOOL_SCHEMAS.find(s => s.function.name === 'generate_image').function.parameters.properties;
  assert.equal(props.size?.type, 'string');
  assert.equal(props.aspect_ratio?.type, 'string');
});

test('image tool passes structured dimensions, supports legacy prompt ratios, and rejects conflicts before dispatch', async () => {
  const calls = [];
  const exec = createMediaToolExecutor({ generateMediaAsync: async (intent) => {
    calls.push(intent); return { type: 'image', url: '/new.png' };
  } });
  await exec('generate_image', { prompt: '海报', aspect_ratio: '2:3' });
  assert.equal(calls[0].size, '1024x1536');
  await exec('generate_image', { prompt: '竖版海报，比例 2:3' });
  assert.equal(calls[1].size, '1024x1536');
  await exec('generate_image', { prompt: '海报', size: '1200x1800', aspect_ratio: '2:3' });
  assert.equal(calls[2].size, '1200x1800');
  for (const args of [{ size: 'nonsense' }, { aspect_ratio: '0:3' }, { size: '1024x1024', aspect_ratio: '2:3' }]) {
    assert.equal((await exec('generate_image', { prompt: '海报', ...args })).isError, true);
  }
  assert.equal(calls.length, 3, '无效/冲突参数不能消费一次方图生成');
});

test('explicit 2:3 and 3:4 override the vague word portrait in image intent', () => {
  assert.equal(detectMediaIntents('画一张2:3竖版海报图')[0].size, '1024x1536');
  assert.equal(detectMediaIntents('画一张3:4竖版海报图')[0].size, '960x1280');
});

test('wrong upstream ratio is delivered as an explicit warning, never a verified success or automatic crop', async () => {
  const exec = createMediaToolExecutor({ generateMediaAsync: async () => ({
    type: 'image', url: '/square.png', verification: { status: 'mismatch', requestedSize: '1024x1536', actualSize: '1024x1024' },
  }) });
  const out = await exec('generate_image', { prompt: '海报', aspect_ratio: '2:3' });
  assert.match(out.text, /未达标/);
  assert.match(out.text, /1024x1536/);
  assert.match(out.text, /1024x1024/);
  assert.doesNotMatch(out.text, /✅/);
  assert.equal(out.media.verification.status, 'mismatch');
});

test('exact ratio with smaller pixels remains usable media but is not presented as compliant', async () => {
  let calls = 0;
  const exec = createMediaToolExecutor({ generateMediaAsync: async () => {
    calls++;
    return { type: 'image', url: '/portrait.png', verification: { status: 'matched', requestedSize: '1024x1536',
      actualSize: '832x1248', exactSize: false, ratioExact: true } };
  } });
  const out = await exec('generate_image', { prompt: '海报', size: '1024x1536', aspect_ratio: '2:3' });
  assert.match(out.text, /⚠️.*像素尺寸未达标/);
  assert.doesNotMatch(out.text, /✅/);
  assert.equal(out.media.url, '/portrait.png');
  assert.ok(!out.isError, 'a delivered image must not trigger another paid generation');
  assert.equal(calls, 1);
});

test('image without dimension evidence cannot be shown as verified, while audio stays unaffected', async () => {
  const exec = createMediaToolExecutor({ generateMediaAsync: async intent => ({ type: intent.type, url: '/asset' }) });
  assert.match((await exec('generate_image', { prompt: '海报' })).text, /⚠️.*尚未核验/);
  assert.match((await exec('generate_tts', { text: '你好' })).text, /✅/);
});
