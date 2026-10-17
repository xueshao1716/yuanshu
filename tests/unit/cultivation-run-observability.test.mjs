// 培养运行的可观测性（2026-10-18）。
//
// 真机现象：18 次运行里 12 次 stopped，但 delegate 只报得出「没有完成：stopped」。
// 根因是原因一直写在 cultivation.reason，而顶层 run.reason 从来没人写，delegate 读的又是顶层。
// 同时 checkpoint 全仓从未推进，永远停在 queued/create，记录里看不到执行到哪一步。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeRunUpdate } from '../../engine/cultivation/task-repository.mjs'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('cultivation.reason 镜像到顶层 reason（delegate 只读顶层）', () => {
  const next = normalizeRunUpdate({ status: 'stopped', cultivation: { reason: 'cultivation_cost_cap_exceeded' } })
  assert.equal(next.reason, 'cultivation_cost_cap_exceeded')
})

test('cultivation.reason 为空时 completed 清空顶层 reason', () => {
  const next = normalizeRunUpdate({ status: 'completed', cultivation: { reason: null } })
  assert.equal(next.reason, null)
})

test('两级都有时以 cultivation.reason 为准（记录里的权威来源）', () => {
  const next = normalizeRunUpdate({ status: 'stopped', reason: 'cancelled', cultivation: { reason: 'cultivation_request_denied' } })
  assert.equal(next.reason, 'cultivation_request_denied')
})

test('不改动传入的 patch 对象', () => {
  const patch = { status: 'stopped', cultivation: { reason: 'cultivation_policy_changed' } }
  normalizeRunUpdate(patch)
  assert.equal(patch.reason, undefined)
})

test('dispatch 在状态流转时推进 checkpoint', () => {
  const src = read('../../engine/cultivation/task-dispatch.mjs')
  assert.match(src, /checkpoint:\{phase:/, 'patch 必须随状态写 checkpoint')
  assert.match(src, /step:'claimed'/, '认领时要记 claimed')
  assert.match(src, /'reserved'/, '预留额度时要记 reserved')
  assert.doesNotMatch(src, /if\(!slot\)return;[\s\S]{0,80}reason/, '无槽位应保持排队而不是伪造原因')
})

test('delegate 读不到顶层时回落到 cultivation.reason', () => {
  const src = read('../../engine/cultivation/delegate.mjs')
  assert.match(src, /run\.reason\|\|run\.cultivation\?\.reason\|\|run\.status/)
})

test('repository 暴露 saveCheckpoint 并在 update 里走归一化', () => {
  const src = read('../../engine/cultivation/task-repository.mjs')
  assert.match(src, /normalizeRunUpdate\(patch\)/)
  assert.match(src, /saveCheckpoint\(key,patch\)/)
})
