import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPosition, panelPosition, normalizeSkin, normalizeMode, imageForSkin, movedEnough } from '../../frontend/src/components/xiaoyu/widget-state.mjs';

test('mascot clamps saved and dragged positions after viewport shrinks', () => {
  assert.deepEqual(clampPosition({ x: 1400, y: 800 }, { width: 320, height: 600 }), { x: 212, y: 388 });
  assert.deepEqual(clampPosition({ x: NaN, y: -10 }, { width: 320, height: 600 }), { x: 12, y: 12 });
  const tiny = clampPosition({ x: 500, y: 500 }, { width: 80, height: 140 });
  assert.deepEqual(tiny, { x: 12, y: 12 });
});
test('panel stays inside viewport on either edge, including short keyboards', () => {
  for (const width of [320, 390, 1440]) for (const height of [280, 900]) {
    for (const x of [0, width - 100]) for (const y of [0, height - 100]) {
      const panel = panelPosition({ x, y }, { width, height }, 360);
      assert.ok(panel.left >= 12 && panel.left + panel.width <= width - 12);
      assert.ok(panel.top >= 12 && panel.top + panel.maxHeight <= height - 12);
    }
  }
});
test('existing skin preferences survive and doll uses one coherent illustration', () => {
  for (const skin of ['chibi', 'doll', 'puppet', 'doll-puppet']) assert.equal(normalizeSkin(skin), skin);
  assert.equal(normalizeSkin('broken'), 'chibi');
  assert.equal(normalizeMode('broken'), 'corner');
  for (const skin of ['doll', 'doll-puppet']) {
    assert.equal(imageForSkin(skin, 'happy'), imageForSkin(skin, 'focused'));
    assert.equal(imageForSkin(skin, 'closed'), imageForSkin(skin, 'open'));
    assert.ok(imageForSkin(skin, 'open').includes('doll-01'));
  }
});
test('drag detection measures travel from pointer origin, not clamp error', () => {
  assert.equal(movedEnough({ x: 100, y: 100 }, { x: 120, y: 100 }), true);
  assert.equal(movedEnough({ x: 100, y: 100 }, { x: 102, y: 101 }), false);
});
