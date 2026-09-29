import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookRuntime } from '../helpers/hook-runtime.mjs';

test('刷新监听随聊天容器重建而重绑，旧容器不再触发', async () => {
  const h = hookRuntime(new URL('../../frontend/src/hooks/usePullToRefresh.ts', import.meta.url), 'usePullToRefresh');
  let count = 0; const refresh = () => { count++; };
  const first = h.element(), second = h.element(); first.scrollTop = second.scrollTop = 0;
  h.render(refresh, first); h.render(refresh, second);
  assert.equal(first.count('touchstart'), 0); assert.equal(second.count('touchstart'), 1);
  second.fire('touchstart', { touches: [{ clientY: 0 }] });
  second.fire('touchmove', { touches: [{ clientY: 200 }] }); second.fire('touchend');
  await Promise.resolve(); assert.equal(count, 1);
  h.unmount(); assert.equal(second.count('touchstart'), 0);
});
