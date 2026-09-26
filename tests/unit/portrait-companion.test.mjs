import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as skin from '../../frontend/src/components/xiaoyu/widget-state.mjs';

test('portrait is the only skin with a stable, local cutout', () => {
  assert.equal(skin.normalizeSkin('portrait'), 'portrait');
  assert.equal(skin.normalizeSkin(null), 'portrait');
  assert.deepEqual(skin.SKINS.map(s => s.id), ['portrait']);
  assert.equal(skin.imageForSkin('portrait'), '/assets/portraits/yuanshu-cutout-v1.webp');
  for (const frame of ['happy', 'focused', 'thinking']) {
    assert.equal(skin.imageForSkin('portrait', frame), skin.imageForSkin('portrait'));
  }
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
  for (const name of ['yuanshu-staircase-v1.webp', 'yuanshu-cutout-v1.webp']) {
    const data = fs.readFileSync(new URL('../../frontend/public/assets/portraits/' + name, import.meta.url));
    assert.equal(data.toString('ascii', 0, 4), 'RIFF');
    assert.equal(data.toString('ascii', 8, 12), 'WEBP');
    assert.ok(data.length > 1000 && data.length < 200000);
  }
  const source = fs.readFileSync(new URL('../../frontend/src/components/xiaoyu/PortraitPreview.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('AI 生成形象 · 全覆盖时装预览'));
  assert.ok(source.includes('/assets/portraits/yuanshu-staircase-v1.webp'));
});
