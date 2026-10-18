// 久不互动推送（2026-10-18）。
// 伙伴：「长时间不互动也可以把消息推送出去的能力也得有」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldNudge, nudgeText, NUDGE_IDLE_MS, NUDGE_COOLDOWN_MS } from '../../engine/companion-nudge.mjs'

const now = new Date(2026, 9, 18, 15, 0, 0).getTime()

test('免打扰 / 从没出现过 / 刚来过 / 冷却中 都不推', () => {
  assert.equal(shouldNudge({ now, seenAt: now - NUDGE_IDLE_MS - 1, dnd: true }).ok, false)
  assert.equal(shouldNudge({ now, seenAt: 0 }).reason, 'never_seen')
  assert.equal(shouldNudge({ now, seenAt: now - 60_000 }).reason, 'recently_seen')
  assert.equal(shouldNudge({ now, seenAt: now - NUDGE_IDLE_MS - 1, nudgeAt: now - 60_000 }).reason, 'cooldown')
})

test('离开够久且不在冷却 → 推', () => {
  const r = shouldNudge({ now, seenAt: now - NUDGE_IDLE_MS - 1, nudgeAt: 0 })
  assert.equal(r.ok, true)
  assert.equal(shouldNudge({ now, seenAt: now - NUDGE_IDLE_MS - 1, nudgeAt: now - NUDGE_COOLDOWN_MS - 1 }).ok, true)
})

test('文案按时间段变化，并带上离开了多久', () => {
  const night = nudgeText({ now: new Date(2026, 9, 18, 2, 0).getTime(), idleMinutes: 30 })
  assert.match(night.body, /早点睡/)
  const morning = nudgeText({ now: new Date(2026, 9, 18, 8, 0).getTime(), idleMinutes: 150 })
  assert.match(morning.body, /2 小时/)
  const evening = nudgeText({ now: new Date(2026, 9, 18, 21, 0).getTime(), idleMinutes: 50 })
  assert.match(evening.body, /50 分钟/)
})

test('真的到期时会调 notifier 并记下推送时间', async () => {
  const sent = []
  let nudgedAt = 0
  const store = {
    seen: () => ({ seenAt: now - NUDGE_IDLE_MS - 1, nudgeAt: nudgedAt }),
    preferences: () => ({ dnd: false }),
    markNudge: (t) => { nudgedAt = t },
  }
  const notifier = { notify: async (e) => { sent.push(e); return { ok: true, event: { id: 'n1' } } } }
  const { runCompanionNudge } = await import('../../engine/companion-nudge.mjs')
  const r = await runCompanionNudge({ store, notifier, now: () => now })
  assert.equal(r.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].kind, 'companion')
  assert.equal(sent[0].toWechat, true, '要能推到应用外面')
  assert.equal(nudgedAt, now, '推送后要记时间，避免下一轮又推')
})

test('不该推的时候不碰 notifier', async () => {
  let called = 0
  const store = { seen: () => ({ seenAt: now - 60_000, nudgeAt: 0 }), preferences: () => ({ dnd: false }), markNudge: () => {} }
  const { runCompanionNudge } = await import('../../engine/companion-nudge.mjs')
  const r = await runCompanionNudge({ store, notifier: { notify: async () => { called++ } }, now: () => now })
  assert.equal(r.ok, false)
  assert.equal(called, 0)
})
