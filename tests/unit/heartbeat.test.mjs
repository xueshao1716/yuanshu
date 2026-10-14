import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createNotifier } from '../../engine/notifier.mjs'
import { createHeartbeat } from '../../engine/heartbeat.mjs'

const quiet = { warn() {} }
const noon = new Date('2026-10-14T12:00:00').getTime()

test('心跳：同一件事只提醒一次，过了 TTL 才再提；新事合并成一条', async () => {
  const n = createNotifier({ log: quiet })
  let t = noon
  let items = [{ key: 'a', text: '承诺 A 逾期' }]
  const hb = createHeartbeat({ notifier: n, sources: [() => items], now: () => t, log: quiet })
  assert.equal((await hb.beat()).sent, true)
  assert.equal((await hb.beat()).sent, false, '同一件事不重复提醒')
  items = [{ key: 'a', text: 'A' }, { key: 'b', text: '名额被卡' }]
  t += 60_000
  assert.equal((await hb.beat()).fresh, 1)
  assert.equal(n.list(0).length, 2)
  assert.match(n.list(0)[1].body, /名额被卡/)
  t += 25 * 3600_000
  assert.equal((await hb.beat()).fresh, 2, 'TTL 过后再提醒')
})

test('心跳：夜间静默不打扰，早上再说；巡检源报错不拖垮其它源', async () => {
  const n = createNotifier({ log: quiet })
  let t = new Date('2026-10-14T02:00:00').getTime()
  const hb = createHeartbeat({ notifier: n, now: () => t, log: quiet,
    sources: [() => { throw new Error('坏源') }, () => [{ key: 'k', text: '事' }]] })
  assert.equal((await hb.beat()).sent, false)
  assert.equal(n.list(0).length, 0)
  t = new Date('2026-10-14T09:00:00').getTime()
  assert.equal((await hb.beat()).sent, true)
})

test('心跳状态落盘，重启后不重复提醒', async () => {
  const file = fs.mkdtempSync(new URL('file:///').pathname.slice(0, 0) + (process.env.TEMP || '/tmp') + '/hb-') + '/h.json'
  const n = createNotifier({ log: quiet })
  const mk = () => createHeartbeat({ notifier: n, file, sources: [() => [{ key: 'x', text: 'x' }]], now: () => noon, log: quiet })
  await mk().beat()
  assert.equal((await mk().beat()).sent, false)
})

test('接线：培养终态钩子与心跳都在 server 里挂上', () => {
  const server = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8')
  assert.match(server, /onRunFinished: run => \{\s*\n\s*const c = run\.cultivation/)
  assert.match(server, /createHeartbeat\(\{ notifier/)
  const dispatch = fs.readFileSync(new URL('../../engine/cultivation/task-dispatch.mjs', import.meta.url), 'utf8')
  assert.match(dispatch, /onRunFinished&&\["completed","failed","stopped","interrupted"\]/)
  assert.match(dispatch, /reason!=="cancelled"/, '用户自己取消的不打扰')
})
