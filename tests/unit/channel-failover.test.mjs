// 2026-11-17 微信端一直回「我这边出了点问题」：deepseek 余额 0（HTTP 402），
// unifiedChat 是 *返回* { error } 而不是抛异常，主对话的换通道只写在 catch 里 → 从不触发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isChannelLevelError } from '../../engine/model/router.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('通道级错误（欠费/鉴权/限流/5xx/断网）判定为可换通道', () => {
  for (const m of ['HTTP 402: Insufficient Balance (request_id: x)', 'HTTP 401: invalid key', 'HTTP 429: rate limit', 'HTTP 503: overloaded', 'fetch failed', 'read ECONNRESET']) {
    assert.equal(isChannelLevelError(m), true, m)
  }
})

test('内容/参数类错误不换通道', () => {
  for (const m of ['', 'HTTP 400: Invalid max_tokens value', '模型空回复', undefined]) {
    assert.equal(isChannelLevelError(m), false, String(m))
  }
})

test('主对话：返回的 error 也走换通道，不只是抛出的异常', () => {
  const src = readFileSync(join(ROOT, 'engine', 'unified-chat.mjs'), 'utf8')
  assert.match(src, /isChannelLevelError\(result\.error\)/, '返回 { error } 时也要判定并换通道')
})
