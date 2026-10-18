// 运行期授权判定（2026-10-18）。
//
// 之前 tasks.mjs 用「控制面 revision 必须完全相等」判断运行是否还能继续：
// 任何无关的控制面写入（他人设计稿、另一个体注册、学习裁决）都会推进 revision，
// 于是在跑的任务被以 policy_changed 终止——真机上 5 次停止就是这么来的。
// 现在只在授权边界真的变了才终止。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { runAuthorization, authorizationBoundary } from '../../engine/cultivation/run-authorization.mjs'

const POLICY = {
  enabled: true,
  expiresAt: '2099-01-01T00:00:00.000Z',
  models: ['stepfun-plan/step-5-preview'],
  allowRemote: false,
}
const RUN = { input: { model: 'stepfun-plan/step-5-preview' } }
const DESIGN = { permissions: { remote: false } }
const AT = Date.parse('2026-10-18T00:00:00.000Z')

test('策略仍授权时放行（无关写入不再打断任务）', () => {
  assert.deepEqual(runAuthorization({ policy: POLICY, design: DESIGN, run: RUN, atMs: AT }), { ok: true })
})

test('额度上调、时间窗这类无关改动不影响运行', () => {
  const relaxed = { ...POLICY, dailyBudgetCents: 99999, dailyRequests: 9999, maxAgents: 99 }
  assert.equal(runAuthorization({ policy: relaxed, design: DESIGN, run: RUN, atMs: AT }).ok, true)
})

test('策略被关闭 → 终止', () => {
  const r = runAuthorization({ policy: { ...POLICY, enabled: false }, design: DESIGN, run: RUN, atMs: AT })
  assert.deepEqual(r, { ok: false, code: 'policy_changed' })
})

test('策略过期 → 终止', () => {
  const r = runAuthorization({ policy: { ...POLICY, expiresAt: '2026-01-01T00:00:00.000Z' }, design: DESIGN, run: RUN, atMs: AT })
  assert.equal(r.ok, false)
})

test('模型被移出白名单 → 终止', () => {
  const r = runAuthorization({ policy: { ...POLICY, models: ['other/model'] }, design: DESIGN, run: RUN, atMs: AT })
  assert.equal(r.ok, false)
})

test('空白名单视为不允许任何模型（受限预设语义）→ 终止', () => {
  const r = runAuthorization({ policy: { ...POLICY, models: [] }, design: DESIGN, run: RUN, atMs: AT })
  assert.equal(r.ok, false)
})

test('远端被关闭时只终止远端运行，本地运行不受影响', () => {
  const remoteDesign = { permissions: { remote: true } }
  assert.equal(runAuthorization({ policy: POLICY, design: remoteDesign, run: RUN, atMs: AT }).ok, false)
  const remoteOn = { ...POLICY, allowRemote: true }
  assert.equal(runAuthorization({ policy: remoteOn, design: remoteDesign, run: RUN, atMs: AT }).ok, true)
  assert.equal(runAuthorization({ policy: POLICY, design: DESIGN, run: RUN, atMs: AT }).ok, true)
})

test('授权边界的快照与字段顺序无关', () => {
  const a = authorizationBoundary({ ...POLICY, models: ['b', 'a'] })
  const b = authorizationBoundary({ ...POLICY, models: ['a', 'b'] })
  assert.deepEqual(a, b)
  assert.equal(a.enabled, true)
})

test('tasks.mjs 不再用整面 revision 相等来判定', () => {
  const src = fs.readFileSync(new URL('../../engine/cultivation/tasks.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /state\.revision!==run\.cultivation\.policyRevision/)
  assert.match(src, /runAuthorization\(/)
})

test('delegate 给出可操作的人话提示', async () => {
  const mod = await import('../../engine/cultivation/delegate.mjs')
  assert.match(mod.REASON_HINT.cultivation_cost_cap_exceeded, /上限|模型/)
  assert.match(mod.REASON_HINT.outcome_unknown, /未知/)
})
