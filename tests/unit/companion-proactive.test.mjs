// 主动互动的时机（2026-10-18）。
// 伙伴反馈："桌面公仔还是死版了些，主动互动能力还是弱了"。
// 原来只有 revision/情绪/30 秒空闲阶段会重新评估，冷启动、久别回来、刚干完活都不会开口。
import test from 'node:test'
import assert from 'node:assert/strict'
import { timeOfDay, proactiveMoments } from '../../frontend/src/components/xiaoyu/companion-state.mjs'

const at = (h, m = 0) => new Date(2026, 9, 18, h, m, 0).getTime()

test('时段划分覆盖全天且边界正确', () => {
  assert.equal(timeOfDay(3), 'lateNight')
  assert.equal(timeOfDay(7), 'morning')
  assert.equal(timeOfDay(10), 'forenoon')
  assert.equal(timeOfDay(12), 'noon')
  assert.equal(timeOfDay(15), 'afternoon')
  assert.equal(timeOfDay(20), 'evening')
  assert.equal(timeOfDay(23), 'lateNight')
  assert.equal(timeOfDay(24), 'unknown')
  assert.equal(timeOfDay('x'), 'unknown')
})

test('刚打开（90 秒内）算一个时机，之后不再算', () => {
  const mountedAt = at(9)
  assert.match(proactiveMoments({ now: mountedAt + 10_000, mountedAt }), /just-open/)
  assert.doesNotMatch(proactiveMoments({ now: mountedAt + 120_000, mountedAt }), /just-open/)
})

test('久别回来（离开 ≥5 分钟）算时机，并按 5 分钟分桶', () => {
  const now = at(9)
  assert.match(proactiveMoments({ now, lastActivityAt: now - 300_000 }), /resume:1/)
  assert.match(proactiveMoments({ now, lastActivityAt: now - 600_000 }), /resume:2/)
  assert.doesNotMatch(proactiveMoments({ now, lastActivityAt: now - 60_000 }), /resume:/)
})

test('刚干完活只在忙→闲那一刻出现', () => {
  assert.match(proactiveMoments({ now: at(9), wasBusy: true, isBusy: false }), /just-finished/)
  assert.doesNotMatch(proactiveMoments({ now: at(9), wasBusy: false, isBusy: false }), /just-finished/)
  assert.doesNotMatch(proactiveMoments({ now: at(9), wasBusy: true, isBusy: true }), /just-finished/)
})

test('时段变化本身就会改变时机串（跨小时能触发一次）', () => {
  const a = proactiveMoments({ now: at(8, 59) })
  const b = proactiveMoments({ now: at(9, 1) })
  assert.notEqual(a, b)
  assert.match(a, /tod:morning/)
  assert.match(b, /tod:morning|tod:forenoon/)
})
