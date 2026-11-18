import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createChatStreamHub, closeHandlerFor } from '../../engine/chat-stream.mjs'

// 2026-11-18 真机：点停止后模型又自顾自想了 4 分 24 秒才停。
// Run 管理器的停止 = 关它自己造的 req；脱钩模式把这个 close 当成"刷新页面"，只 detach 不 abort。
test('Run 托管的请求被关闭（= 伙伴点停止）：必须立刻中断模型调用', () => {
  const stream = createChatStreamHub().create('s1')
  const nativeRes = { write() {}, writeHead() {} }
  stream.attach(nativeRes)
  closeHandlerFor(stream, nativeRes, { ownedByRun: true })()
  assert.equal(stream.signal.aborted, true)
  assert.equal(stream.signal.reason?.code, 'user_stop')
})

test('浏览器直连断开（刷新/切后台）：只断显示，任务继续', () => {
  const stream = createChatStreamHub().create('s2')
  const nativeRes = { write() {}, writeHead() {} }
  stream.attach(nativeRes)
  closeHandlerFor(stream, nativeRes, { ownedByRun: false })()
  assert.equal(stream.signal.aborted, false)
})

test('server.mjs 按是否 Run 托管挑 close 行为', () => {
  const src = readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8')
  assert.match(src, /closeHandlerFor\(stream, nativeRes, \{ ownedByRun \}\)/)
})
