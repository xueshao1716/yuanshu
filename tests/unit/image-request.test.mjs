import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveImageRequest } from '../../engine/image-request.mjs';

test('explicit parameters outrank prose and valid custom ratios work with size', () => {
  assert.equal(resolveImageRequest({ size: '1024×1536' }, 'square 1:1').size, '1024x1536');
  assert.deepEqual(resolveImageRequest({ size: '1400x1000', aspect_ratio: '7:5' }), { size: '1400x1000', aspectRatio: '7:5' });
  assert.throws(() => resolveImageRequest({ aspect_ratio: '7:5' }), /size/);
  assert.throws(() => resolveImageRequest({ size: '10x1000' }), /无效/);
});

test('legacy pixel prose is passed as a real size instead of silently defaulting to square', () => {
  assert.equal(resolveImageRequest({}, '海报 1000×1500 pixels').size, '1000x1500');
  assert.equal(resolveImageRequest({}, '尺寸 1200 x 1800 像素，竖版').size, '1200x1800');
  assert.equal(resolveImageRequest({}, '竖版 4:6').aspectRatio, '2:3');
  assert.deepEqual(resolveImageRequest({}, '普通聊天 2026×10000 数据'), {});
});
