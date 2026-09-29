import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookRuntime } from '../helpers/hook-runtime.mjs';

const initial = { sessionKey: 'A', lastMessageKey: '1:a', lastFromUser: false };
function setup() {
  const h = hookRuntime(new URL('../../frontend/src/hooks/useAutoScroll.ts', import.meta.url), 'useAutoScroll');
  const el = h.element(); h.render(initial, el); h.flush(); h.flush(); el.scrollTop = 1500;
  return { h, el };
}
test('底部首次上滚立即取消已经排队的流式回底', () => {
  const { h, el } = setup(); h.result.scrollToBottom();
  el.fire('wheel', { deltaY: -80 }); el.scrollTop = 1420; el.fire('scroll');
  h.flush(); assert.equal(el.scrollTop, 1420);
});
test('用户阅读期间的历史重载，即使末条是用户消息也不强制回底', () => {
  const { h, el } = setup(); el.scrollTop = 1200; el.fire('wheel', { deltaY: -80 }); el.fire('scroll');
  h.render({ ...initial, lastMessageKey: '10:u', lastFromUser: true }); h.flush();
  assert.equal(el.scrollTop, 1200);
});
test('切会话重新绑定新容器并移除旧容器监听', () => {
  const { h, el } = setup(), next = h.element(); h.render({ ...initial, sessionKey: 'B' }, next);
  assert.equal(el.count('wheel'), 0); assert.equal(next.count('wheel'), 1);
});
test('用户主动回到底部后恢复跟随', () => {
  const { h, el } = setup(); el.fire('wheel', { deltaY: -80 }); el.scrollTop = 1200; el.fire('scroll');
  el.scrollTop = 1500; el.fire('scroll'); el.scrollHeight = 2300;
  h.result.scrollToBottom(); h.flush(); assert.equal(el.scrollTop, 2300);
});
test('点击回到底部解除阅读锁，下一次增长继续跟随', () => {
  const { h, el } = setup(); el.fire('wheel', { deltaY: -80 }); el.scrollTop = 1200; el.fire('scroll');
  h.result.scrollToBottom(true); h.flush(); el.scrollHeight = 2600;
  h.result.scrollToBottom(); h.flush(); assert.equal(el.scrollTop, 2600);
});
test('触屏拖动会取消待执行滚动', () => {
  const { h, el } = setup(); h.result.scrollToBottom();
  el.fire('pointerdown'); el.fire('touchstart', { touches: [{ clientY: 100 }] });
  el.fire('touchmove', { touches: [{ clientY: 160 }] }); el.scrollTop = 1440; el.fire('scroll');
  h.flush(); assert.equal(el.scrollTop, 1440);
});
test('卸载后排队滚动不可碰新容器', () => {
  const { h, el } = setup(); h.result.scrollToBottom(); h.unmount(); el.scrollTop = 1234;
  h.flush(); assert.equal(el.scrollTop, 1234);
});
test('贴底时图片撑高超过阈值也跟随，阅读中则不跟随', () => {
  const { h, el } = setup(); el.scrollHeight = 2800; h.resize(); h.flush(); h.flush();
  assert.equal(el.scrollTop, 2800);
  el.scrollTop = 1000; el.fire('wheel', { deltaY: -80 }); el.fire('scroll');
  el.scrollHeight = 3100; h.resize(); h.flush(); h.flush(); assert.equal(el.scrollTop, 1000);
});
