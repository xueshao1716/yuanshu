import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSealed, activeWindows, excludeSealed, rateInWindow, evaluateSealed, sealedSummary } from '../../engine/sealed-window.mjs'

function tempWs() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sealed-'))
  fs.mkdirSync(path.join(d, '工程', '经验库'), { recursive: true })
  return d
}
const run = (at, status = 'ok') => ({ startedAt: at, status })
const DAY = 86400_000

test('开窗：同一任务不重复开；活动窗口可查', () => {
  const ws = tempWs()
  const now = Date.now()
  const a = openSealed(ws, { taskId: 't1', label: '反思', change: 'x', now })
  assert.equal(a.ok, true)
  const b = openSealed(ws, { taskId: 't1', label: '反思', now })
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'active-exists')
  assert.equal(activeWindows(ws, now).length, 1)
})

test('排除：窗口内的运行不进入调参数据', () => {
  const now = Date.now()
  openSealed(tempWs().length ? tempWs() : tempWs(), { taskId: 'x' }) // 触发一次默认参数，避免未用导入
  const ws = tempWs()
  const w = openSealed(ws, { taskId: 't1', now }).window
  const runs = [run(now - DAY), run(now + DAY), run(now + 2 * DAY)]
  const kept = excludeSealed(runs, [w])
  assert.equal(kept.length, 1, '窗口外的保留，窗口内的排除')
  assert.equal(kept[0].startedAt, now - DAY)
})

test('评测：样本够时按阈值给结论，且只评一次', () => {
  const ws = tempWs()
  const now = Date.now()
  openSealed(ws, { taskId: 't1', label: '反思', now, baseline: { rate: 1 } })
  // 窗口内 3 次全失败 → worse
  const runsByTask = { t1: [run(now + DAY, 'error'), run(now + 2 * DAY, 'error'), run(now + 3 * DAY, 'error')] }
  const r = evaluateSealed(ws, { runsByTask, now: now + 8 * DAY })
  assert.equal(r.evaluated.length, 1)
  assert.equal(r.evaluated[0].verdict, 'worse')
  assert.match(fs.readFileSync(path.join(ws, '工程', '经验库', '封存评测.md'), 'utf8'), /更差/)
  // 再评不会重复
  const again = evaluateSealed(ws, { runsByTask, now: now + 9 * DAY })
  assert.equal(again.evaluated.length, 0)
})

test('评测：到期但样本不足 → insufficient，不硬说有结论', () => {
  const ws = tempWs()
  const now = Date.now()
  openSealed(ws, { taskId: 't1', now })
  const r = evaluateSealed(ws, { runsByTask: { t1: [run(now + DAY)] }, now: now + 8 * DAY })
  assert.equal(r.evaluated[0].verdict, 'insufficient')
})

test('未到期且样本不足：先不评', () => {
  const ws = tempWs()
  const now = Date.now()
  openSealed(ws, { taskId: 't1', now })
  const r = evaluateSealed(ws, { runsByTask: { t1: [run(now + DAY)] }, now: now + DAY })
  assert.equal(r.evaluated.length, 0)
})

test('rateInWindow：按区间统计成功率', () => {
  const now = Date.now()
  const r = rateInWindow([run(now, 'ok'), run(now + 1, 'error'), run(now - 10 * DAY, 'ok')], now, now + 1000)
  assert.equal(r.samples, 2)
  assert.equal(r.ok, 1)
  assert.equal(r.rate, 0.5)
})

test('摘要：活动/已完成/下一个到期天数', () => {
  const ws = tempWs()
  const now = Date.now()
  openSealed(ws, { taskId: 't1', now, days: 7 })
  const s = sealedSummary(ws, now)
  assert.equal(s.active, 1)
  assert.equal(s.done, 0)
  assert.equal(s.nextDueDays, 7)
})
