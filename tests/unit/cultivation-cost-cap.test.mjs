import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectProvider } from '../../engine/cultivation/provider-inspection.mjs'

const model = { provider: 'stepfun-plan', id: 'step-5-preview', name: 'step-5', input: ['text'], reasoning: true }
const catalog = async () => [model]
const shared = (rate) => ({ inputTokens: 6000, outputTokens: 4096, allowedModels: ['stepfun-plan/step-5-preview'], currency: 'USD', rates: { 'stepfun-plan/step-5-preview': rate } })
const policy = { models: ['stepfun-plan/step-5-preview'], tools: [], allowRemote: true, dailyBudgetCents: 200, timeoutMs: 600000 }
const design = (cap) => ({ permissions: { model: 'stepfun-plan/step-5-preview', remote: true, costUpperBoundCents: cap } })
const rate = (n) => ({ input: n, output: n, currency: 'USD', free: false, tokenBound: 'utf8-bytes' })

test('单价×输出额度的最坏费用超过设计单次上限：预检直接报 cost_cap_exceeded，不等运行时被拒', async () => {
  const bad = await inspectProvider(catalog, { design: design(30), policy, sharedPolicy: shared(rate(100)) })
  const hit = bad.blockedBy.find((b) => b.code === 'cultivation_cost_cap_exceeded')
  assert.ok(hit, JSON.stringify(bad.blockedBy))
  assert.match(hit.message, /41 美分/)
  const ok = await inspectProvider(catalog, { design: design(30), policy, sharedPolicy: shared(rate(1)) })
  assert.ok(!ok.blockedBy.some((b) => b.code === 'cultivation_cost_cap_exceeded'))
})

test('调度器把拒绝原因分开，不再统一报 request_denied', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../engine/cultivation/task-dispatch.mjs', import.meta.url), 'utf8')
  for (const code of ['cultivation_remote_mismatch', 'cultivation_price_invalid', 'cultivation_cost_cap_exceeded']) assert.ok(src.includes(code), code)
  assert.ok(!src.includes("throw new Error('cultivation_request_denied')"))
})
