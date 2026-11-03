import test from 'node:test';
import assert from 'node:assert/strict';

import { ok } from '../../engine/selfchange-smoke.mjs';
import smokeDefault from '../../engine/selfchange-smoke.mjs';

test('engine/selfchange-smoke.mjs 导出 ok === true', () => {
  assert.equal(ok, true);
  assert.equal(typeof ok, 'boolean');
});

test('engine/selfchange-smoke.mjs 默认导出携带同一个 ok 值', () => {
  assert.equal(smokeDefault.ok, true);
});
