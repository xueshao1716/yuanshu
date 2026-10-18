// 培养越线授权链路（2026-10-18）。
// 伙伴：「新授权应该出现在等我确认」——查下来 cultivation-policy 这个类型从来没有注册点。
// 现在：申请落盘 + 挂卡；批准用会话授权拿一次性凭证执行那一次；拒绝/过期留痕。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApprovalFlow } from '../../engine/cultivation/approval-flow.mjs'
import { findRequest, pendingRequests } from '../../engine/cultivation/approval-requests.mjs'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-approval-'))

/** 假的确认注册表：register 返回 id + promise，settle 用 ok 解开。 */
function fakeRegistry() {
  const rows = new Map()
  let seq = 0
  const api = {
    rows,
    register(sessionId, payload) {
      const id = payload.id || `c${++seq}`
      let resolve
      const promise = new Promise((r) => { resolve = r })
      rows.set(`${sessionId}:${id}`, { ...payload, id, sessionId, resolve })
      return { id, promise, sessionId }
    },
    settle(sessionId, id, ok) {
      const row = rows.get(`${sessionId}:${id}`)
      if (!row) return { ok: false, error: '确认不存在或已过期' }
      rows.delete(`${sessionId}:${id}`)
      row.resolve(ok ? 'allowed-once' : 'rejected')
      return { ok: true, outcome: ok ? 'allowed-once' : 'rejected' }
    },
    list() { return [...rows.values()].map(({ resolve, ...rest }) => rest) },
  }
  return api
}

/** 假的运行时：模拟 session-grants 的 challenge → confirm → verify → execute。 */
function fakeRuntime(registry) {
  const executed = []
  const challenges = new Map()
  const api = {
    executed,
    sessionChallenge(command, sessionId) {
      const reg = registry.register(sessionId, { toolName: 'cultivation-policy', reason: '内部凭证', meta: {} })
      challenges.set(reg.id, reg.promise)
      return { id: reg.id }
    },
    async sessionConfirm(id) {
      // settle 会把行从注册表里删掉，所以 promise 必须在 challenge 时就留住
      const outcome = await (challenges.get(id) ?? Promise.resolve('rejected'))
      if (outcome !== 'allowed-once') throw new Error('cultivation_identity_denied')
      challenges.delete(id)
      return { id, token: 't1' }
    },
    verifySession() { return { kind: 'human', source: { ok: true } } },
    async execute(command) { executed.push(command); return { ok: true, action: command.action } },
  }
  return api
}

const policy = (over = {}) => ({
  enabled: true, maxAgents: 30, maxConcurrent: 8, dailyRequests: 2000, dailyBudgetCents: 20000,
  currency: 'USD', allowRemote: true, recursive: false, models: ['stepfun-plan/step-5-preview'],
  tools: [], dataScopes: ['knowledge:approved-cultivation'], motherLearning: false, ...over,
})

test('申请会落盘，并在确认表里挂上一张 cultivation-policy 卡', () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime: fakeRuntime(registry) })
  const r = flow.request({ sessionId: 's1', command: { action: 'policy.set', payload: { policy: policy({ dailyBudgetCents: 50000 }) } }, reason: '想把日预算提到 500 美元' })
  assert.ok(r.requestId)
  assert.equal(pendingRequests(ws).length, 1)
  const card = registry.list().find((x) => x.toolName === 'cultivation-policy')
  assert.ok(card, '必须挂卡，否则授权中心看不到')
  assert.equal(card.meta.requestId, r.requestId)
  assert.match(card.reason, /小语申请越线授权/)
})

test('批准 → 执行那条命令一次，申请变成 approved', async () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const runtime = fakeRuntime(registry)
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime })
  const { requestId } = flow.request({ sessionId: 's1', command: { action: 'policy.set', payload: { policy: policy({ dailyBudgetCents: 50000 }) } }, reason: 'x' })

  const out = await flow.approve(requestId, 's1')
  assert.equal(out.ok, true, out.error)
  assert.equal(runtime.executed.length, 1)
  assert.equal(runtime.executed[0].action, 'policy.set')
  assert.equal(findRequest(ws, requestId).status, 'approved')
})

test('重复批准不会再执行第二次（一次性）', async () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const runtime = fakeRuntime(registry)
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime })
  const { requestId } = flow.request({ sessionId: 's1', command: { action: 'policy.set', payload: { policy: policy() } }, reason: 'x' })
  await flow.approve(requestId, 's1')
  const again = await flow.approve(requestId, 's1')
  assert.equal(again.ok, false)
  assert.match(again.error, /已处理/)
  assert.equal(runtime.executed.length, 1, '只执行一次')
})

test('拒绝：不执行，申请标记 rejected', () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const runtime = fakeRuntime(registry)
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime })
  const { requestId } = flow.request({ sessionId: 's1', command: { action: 'policy.set', payload: { policy: policy() } }, reason: 'x' })
  flow.reject(requestId)
  assert.equal(findRequest(ws, requestId).status, 'rejected')
  assert.equal(runtime.executed.length, 0)
})

test('别的会话不能批准；过期申请不能批准', async () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const runtime = fakeRuntime(registry)
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime, ttlMs: 60_000 })
  const { requestId } = flow.request({ sessionId: 's1', command: { action: 'policy.set', payload: { policy: policy() } }, reason: 'x' })

  const foreign = await flow.approve(requestId, 's2')
  assert.equal(foreign.ok, false)
  assert.match(foreign.error, /不属于该会话/)

  // 把有效期改到过去，模拟等太久
  const file = path.join(ws, '记忆', '运行时', '培养授权申请.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.requests[0].expiresAt = Date.now() - 1000
  fs.writeFileSync(file, JSON.stringify(data), 'utf8')

  const expired = await flow.approve(requestId, 's1')
  assert.equal(expired.ok, false)
  assert.match(expired.error, /已过期/)
  assert.equal(runtime.executed.length, 0)
})

test('没有会话上下文就不能申请', () => {
  const ws = tmpRoot()
  const registry = fakeRegistry()
  const flow = createApprovalFlow({ registry, wsRoot: ws, runtime: fakeRuntime(registry) })
  assert.throws(() => flow.request({ sessionId: '', command: { action: 'policy.set', payload: { policy: policy() } } }), /没有会话上下文/)
})
