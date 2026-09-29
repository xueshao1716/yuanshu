import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { portraitAssetUrl } from '../../frontend/src/components/xiaoyu/portrait-asset.mjs';
import { GALLERIES, imageForSkin } from '../../frontend/src/components/xiaoyu/widget-state.mjs';

test('a release changes the cache identity of every gallery pose without changing its group', () => {
  for (const gallery of GALLERIES) {
    for (const action of ['working', 'reading', 'resting', 'daydreaming', 'listening', 'responding', 'neutral']) {
      const src = imageForSkin(gallery.id, action);
      const previous = portraitAssetUrl(src, '2.116.30');
      const next = portraitAssetUrl(src, '2.116.31');
      assert.notEqual(previous, next);
      const url = new URL(next, 'http://localhost');
      assert.equal(url.pathname, src);
      assert.equal(url.searchParams.get('v'), '2.116.31');
      assert.equal(portraitAssetUrl(next, '2.116.31'), next);
    }
  }
});

test('portrait revision preserves other query parameters and never rewrites unrelated URLs', () => {
  assert.equal(portraitAssetUrl('/assets/portraits/a.webp?size=small&v=old#pose', '2.116.31'), '/assets/portraits/a.webp?size=small&v=2.116.31#pose');
  assert.equal(portraitAssetUrl('/assets/portraits/a.webp', ''), '/assets/portraits/a.webp');
  assert.equal(portraitAssetUrl('https://example.com/a.webp', '2.116.31'), 'https://example.com/a.webp');
});

test('portrait rendering and download use the same build-version cache identity', () => {
  const read = name => fs.readFileSync(new URL('../../frontend/src/components/xiaoyu/' + name, import.meta.url), 'utf8');
  assert.ok(read('PortraitState.tsx').split('\n').some(line => line.includes('portraitAssetUrl(asset.src)')));
  assert.ok(read('WidgetPanel.tsx').split('\n').some(line => line.includes('href={portraitAssetUrl(imageForSkin(skin, c.action))}')));
});
