// 账号管理"切换"的目标判定（2026-10-18）。
// 原来只写 localStorage 再 reload，地址栏不变 → 对远程实例等于没切换。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSwitchTarget } from '../../frontend/src/lib/switch-target.mjs'

const HERE = 'http://127.0.0.1:8787/'

test('本机档案（空 apiBase）：沿用当前源，只换令牌', () => {
  assert.deepEqual(resolveSwitchTarget({ apiBase: '', token: 'abc', currentHref: HERE }), { kind: 'reload' })
})

test('同一实例：刷新即可，不跳转', () => {
  assert.deepEqual(resolveSwitchTarget({ apiBase: 'http://127.0.0.1:8787', token: 'abc', currentHref: HERE }), { kind: 'reload' })
})

test('另一个实例：真的跳转到那个地址', () => {
  const r = resolveSwitchTarget({ apiBase: 'http://192.168.1.5:8787', token: 'abc', currentHref: HERE })
  assert.equal(r.kind, 'navigate')
  assert.equal(r.url, 'http://192.168.1.5:8787/')
})

test('远程地址不把令牌塞进 URL（服务端不会消费，只会把令牌留在地址栏）', () => {
  const r = resolveSwitchTarget({ apiBase: 'https://yuanshu.example.com', token: 'secret-token-123', currentHref: HERE })
  assert.equal(r.kind, 'navigate')
  assert.equal(r.tokenInQuery, false)
  assert.doesNotMatch(r.url, /secret-token-123/)
})

test('回环地址之间可以带令牌过去（服务端只对本机回环消费 ?t=）', () => {
  const r = resolveSwitchTarget({ apiBase: 'http://127.0.0.1:9000', token: 'abc12345', currentHref: HERE })
  assert.equal(r.kind, 'navigate')
  assert.equal(r.tokenInQuery, true)
  assert.match(r.url, /^http:\/\/127\.0\.0\.1:9000\/\?t=abc12345$/)
})

test('没有令牌时回环地址也不带空参数', () => {
  const r = resolveSwitchTarget({ apiBase: 'http://localhost:8899', token: '', currentHref: HERE })
  assert.equal(r.url, 'http://localhost:8899/')
  assert.equal(r.tokenInQuery, false)
})

test('保留路径与端口，去掉尾部斜杠', () => {
  const r = resolveSwitchTarget({ apiBase: 'http://10.0.0.8:8787/', token: '', currentHref: HERE })
  assert.equal(r.url, 'http://10.0.0.8:8787/')
})

test('非 http(s) 输入原样交给浏览器，不假装能带令牌', () => {
  const r = resolveSwitchTarget({ apiBase: 'ftp://x/y', token: 'abc', currentHref: HERE })
  assert.equal(r.kind, 'navigate')
  assert.equal(r.tokenInQuery, false)
})
