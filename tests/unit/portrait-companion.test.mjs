import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as skin from '../../frontend/src/components/xiaoyu/widget-state.mjs';
import { portraitFor } from '../../frontend/src/components/xiaoyu/companion-state.mjs';

test('gallery resolver honors every original-gallery action too', () => {
  for (const action of ['working', 'reading', 'resting', 'daydreaming', 'listening', 'responding']) {
    assert.equal(skin.imageForSkin('portrait', action), portraitFor(action).src);
  }
});

test('author listening and neutral retain the original matching set instead of the green-screen replacement', () => {
  // Original author set, normalized by finalize-portrait-u2net.py, as committed
  // before the isolated green-screen listening replacement (user identified 2A).
  const expectedHash = 'ad2550d74b36764b912d282123ed0051ce08e45b7ca496a508def915ed724c06';
  for (const action of ['listening', 'neutral', 'unknown']) {
    const src = skin.imageForSkin('portrait-life', action);
    const bytes = fs.readFileSync(new URL('../../frontend/public' + src, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash,
      `${action} must use the original author-set artwork, not merely a correctly named file`);
    assert.equal(src, '/assets/portraits/yuanshu-life-listening-author-v3.webp',
      'the restored bitmap needs a new URL instead of reusing the immutable v2 resource');
  }
});

test('four galleries keep all 24 action assets separate and fall back only inside their group', () => {
  const suffixes = { portrait: 'v1', 'portrait-life': 'author-v2', 'portrait-uniform': 'v3', 'portrait-daily': 'v1' };
  const hashes = new Set();
  for (const gallery of skin.GALLERIES) {
    const prefix = gallery.id === 'portrait' ? 'yuanshu-' : 'yuanshu-life-';
    for (const action of ['working', 'reading', 'resting', 'daydreaming', 'listening', 'responding']) {
      const src = skin.imageForSkin(gallery.id, action);
      const suffix = gallery.id === 'portrait-life' && action === 'listening' ? 'author-v3' : suffixes[gallery.id];
      assert.equal(src, `/assets/portraits/${prefix}${action}-${suffix}.webp`);
      const bytes = fs.readFileSync(new URL('../../frontend/public' + src, import.meta.url));
      hashes.add(createHash('sha256').update(bytes).digest('hex'));
    }
    assert.equal(skin.imageForSkin(gallery.id, 'unknown'), skin.imageForSkin(gallery.id, 'listening'));
  }
  assert.equal(hashes.size, 24, 'no group or action is silently using another asset');
});

test('portrait wardrobe has stable local presets and keeps legacy preferences safe', () => {
  assert.equal(skin.normalizeSkin('portrait'), 'portrait');
  assert.equal(skin.normalizeSkin(null), 'portrait');
  assert.equal(skin.normalizeSkin('wardrobe-jk'), 'portrait-life');
  assert.ok(skin.SKINS.length >= 5);
  assert.ok(skin.SKINS.some(s => s.id === 'wardrobe-jk'));
  assert.equal(skin.imageForSkin('portrait'), '/assets/portraits/yuanshu-listening-v1.webp');
  assert.ok(skin.imageForSkin('wardrobe-jk').endsWith('yuanshu-wardrobe-jk-v1.png'));
  assert.equal(skin.normalizeSkin('broken'), 'portrait');
  for (const frame of ['happy', 'focused', 'thinking']) {
    assert.equal(skin.imageForSkin('portrait', frame), skin.imageForSkin('portrait'));
  }
});
test('alternate portrait gallery keeps action-driven state while changing outfit set', () => {
  assert.ok(skin.GALLERIES.some(g => g.id === 'portrait'));
  assert.ok(skin.GALLERIES.some(g => g.id === 'portrait-life'));
  assert.equal(skin.normalizeSkin('portrait-life'), 'portrait-life');
  const actions = ['working', 'reading', 'resting', 'daydreaming', 'listening', 'responding'];
  for (const action of actions) {
    const src = skin.imageForSkin('portrait-life', action);
    assert.ok(src.startsWith('/assets/portraits/yuanshu-life-'));
  }
  const panel = fs.readFileSync(new URL('../../frontend/src/components/xiaoyu/WidgetPanel.tsx', import.meta.url), 'utf8');
  assert.ok(panel.includes('切换状态图库'));
  assert.ok(panel.includes('完整立绘组'));
});
test('old skins migrate to non-roaming portrait', () => {
  assert.equal(typeof skin.canRoam, 'function');
  assert.equal(skin.canRoam('portrait'), false);
  for (const id of ['chibi', 'doll', 'puppet', 'doll-puppet']) assert.equal(skin.canRoam(id), false);
});
test('portrait motion and preview have explicit isolated wiring', () => {
  const read = p => fs.readFileSync(new URL('../../frontend/src/components/' + p, import.meta.url), 'utf8');
  assert.ok(read('XiaoyuWidget.tsx').includes('useWidgetMotion(true)'));
  assert.ok(!read('XiaoyuWidget.tsx').includes('motion.face'));
  assert.ok(read('XiaoyuWidget.tsx').includes('useCompanion'));
  assert.ok(read('xiaoyu/WidgetPanel.tsx').includes('PortraitState'));
  assert.ok(!read('xiaoyu/WidgetPanel.tsx').includes('WidgetStudio'));
});
test('portrait assets are packaged locally and preview disclosure is explicit', () => {
  for (const name of ['yuanshu-working-v1.webp', 'yuanshu-reading-v1.webp', 'yuanshu-resting-v1.webp', 'yuanshu-daydreaming-v1.webp', 'yuanshu-listening-v1.webp', 'yuanshu-responding-v1.webp']) {
    const data = fs.readFileSync(new URL('../../frontend/public/assets/portraits/' + name, import.meta.url));
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WEBP');
    assert.ok(data.length > 1000 && data.length < 800000);
  }
  const life = ['working', 'reading', 'resting', 'daydreaming', 'listening', 'responding'];
  const hashes = new Set();
  for (const name of life.map(n => `yuanshu-life-${n}-v1.webp`)) {
    const data = fs.readFileSync(new URL('../../frontend/public/assets/portraits/' + name, import.meta.url));
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WEBP');
    assert.ok(data.length > 30000);
    hashes.add(data.toString('base64').slice(0, 120));
  }
  assert.equal(hashes.size, life.length, '生活状态图库不能复用同一张图');
  for (const name of ['yuanshu-wardrobe-jk-v1.png', 'yuanshu-wardrobe-skirt-v1.png', 'yuanshu-wardrobe-trousers-v1.png', 'yuanshu-wardrobe-collar-v1.png', 'yuanshu-wardrobe-openai-v1.png']) {
    const data = fs.readFileSync(new URL('../../frontend/public/assets/portraits/' + name, import.meta.url));
    assert.equal(data.toString('ascii', 1, 4), 'PNG');
    assert.ok(data.length > 100000);
  }
  const source = fs.readFileSync(new URL('../../frontend/src/components/xiaoyu/PortraitPreview.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('AI 生成形象 · 全覆盖时装预览'));
  assert.ok(source.includes('/assets/portraits/yuanshu-listening-v1.webp'));
});
