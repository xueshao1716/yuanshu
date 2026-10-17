// 2026-10-17：模型失败取证日志 + 上游 max_tokens 硬区间兜底。
// 背景：用户报「deepseek 400」，但会话里只留了摘要，上游原文丢了，复现全靠猜。
// 这里保证：失败时一定留下「请求形状 + 上游原文（脱敏）」，且输出预算永不越过上游硬区间。
import test from 'node:test'
import assert from 'node:assert/strict'
import { logModelFailure, redactSecrets } from '../../engine/model-diagnostics.mjs'
import {
  clampOutputTokens,
  escalateOutputTokens,
  providerOutputCeiling,
  OUTPUT_TOKEN_CEILING,
  OUTPUT_TOKEN_HARD_CAP,
} from '../../engine/output-budget.mjs'

test('失败日志带请求形状与上游原文', () => {
  const calls = []
  const orig = console.error
  console.error = (m) => calls.push(m)
  try {
    logModelFailure({
      where: 'unified-chat',
      model: { provider: 'deepseek', id: 'deepseek-flash' },
      status: 400,
      body: '{"error":{"message":"Invalid max_tokens value, the valid range of max_tokens is [1, 393216]"}}',
      request: { messages: 7, tools: 3, outputBudget: 8192, thinking: true, stream: true },
    })
  } finally {
    console.error = orig
  }
  assert.equal(calls.length, 1)
  assert.match(calls[0], /^\[model-failure\] /)
  const line = JSON.parse(calls[0].slice('[model-failure] '.length))
  assert.equal(line.status, 400)
  assert.equal(line.provider, 'deepseek')
  assert.equal(line.model, 'deepseek-flash')
  assert.equal(line.request.outputBudget, 8192)
  assert.match(line.upstream, /Invalid max_tokens value/)
})

test('上游原文里的密钥必须脱敏', () => {
  assert.equal(redactSecrets('key sk-abcdefgh12345678 here'), 'key sk-*** here')
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123456'), 'Authorization: Bearer ***')
})

test('超长上游原文被截断，不会把日志撑爆', () => {
  const calls = []
  const orig = console.error
  console.error = (m) => calls.push(m)
  try { logModelFailure({ where: 'x', status: 500, body: 'e'.repeat(5000) }) } finally { console.error = orig }
  const line = JSON.parse(calls[0].slice('[model-failure] '.length))
  assert.equal(line.upstream.length, 800)
})

test('deepseek 家族有明确的上游硬区间', () => {
  assert.equal(providerOutputCeiling({ id: 'deepseek-flash' }), 393216)
  assert.equal(providerOutputCeiling({ id: 'deepseek-v4-pro' }), 393216)
  assert.equal(providerOutputCeiling({ id: 'glm-5.3' }), Infinity)
})

test('声明值再大也不会越过上游硬区间', () => {
  const deepseek = { id: 'deepseek-flash', limitsSource: 'provider', maxTokens: 1000000, contextWindow: 1000000 }
  assert.ok(clampOutputTokens(deepseek) <= OUTPUT_TOKEN_CEILING)
  // 截断重试连翻两轮也不能突破 393216（这里 hardCap 131072 本来更小，取最小者）
  let budget = clampOutputTokens(deepseek)
  for (let i = 0; i < 6; i++) budget = escalateOutputTokens(budget, deepseek)
  assert.ok(budget <= OUTPUT_TOKEN_HARD_CAP, `预算 ${budget} 不应超过硬顶`)
  assert.ok(budget <= 393216, `预算 ${budget} 不应超过上游区间`)
})

test('其他厂商不受 deepseek 区间影响', () => {
  const glm = { id: 'glm-5.3', limitsSource: 'provider', maxTokens: 200000, contextWindow: 200000 }
  assert.equal(providerOutputCeiling(glm), Infinity)
  assert.ok(clampOutputTokens(glm) <= OUTPUT_TOKEN_CEILING)
})
