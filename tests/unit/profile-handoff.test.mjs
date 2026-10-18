// 账号档案跨源交接（2026-10-18）。
// 现象：切到另一个地址后账号列表空了（localStorage 按源隔离），且我上一版让"新增"自动跳转，
// 一跳过去就"啥都没有了"。修正：不自动跳转 + 交接只带标签和地址、绝不带令牌。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeProfileHandoff, decodeProfileHandoff, mergeProfileHandoff, consumeProfileHandoff,
} from '../../frontend/src/lib/profile-handoff.mjs'

const LIST = [
  { id: 'a#1111', label: '客厅', apiBase: 'http://192.168.1.5:8787', token: 'secret-token-a', savedAt: 1 },
  { id: 'b#2222', label: '本机', apiBase: '', token: 'secret-token-b', savedAt: 2 },
]

test('交接只编码标签与地址，绝不带令牌', () => {
  const code = encodeProfileHandoff(LIST)
  assert.ok(code.length > 0)
  const decoded = decodeProfileHandoff(code)
  assert.equal(decoded.length, 2)
  assert.equal(decoded[0].apiBase, 'http://192.168.1.5:8787')
  assert.equal(decoded[0].label, '客厅')
  // 令牌既不在载荷里，也不在编码后的字符串里
  assert.equal('token' in decoded[0], false)
  assert.doesNotMatch(code, /secret-token/)
  assert.doesNotMatch(decodeURIComponent(code), /secret-token/)
})

test('编解码可往返，坏输入返回空而不是抛错', () => {
  assert.equal(encodeProfileHandoff([]), '')
  assert.deepEqual(decodeProfileHandoff(''), [])
  assert.deepEqual(decodeProfileHandoff('%%%not-base64%%%'), [])
})

test('合并时保留本地令牌，交接进来的条目令牌为空', () => {
  const merged = mergeProfileHandoff(
    [{ id: 'a#x', label: '客厅', apiBase: 'http://192.168.1.5:8787', token: 'keep-me', savedAt: 1 }],
    [{ label: '客厅', apiBase: 'http://192.168.1.5:8787' }, { label: '妹妹的', apiBase: 'https://y.example.com' }],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].token, 'keep-me', '同地址不能被交接覆盖掉本地令牌')
  assert.equal(merged[1].apiBase, 'https://y.example.com')
  assert.equal(merged[1].token, '', '新地址没有令牌，需要用户在那台输入')
})

test('从地址栏读取交接后要把它从 hash 里抹掉', () => {
  const code = encodeProfileHandoff(LIST)
  let replaced = null
  const loc = { hash: `#ph=${code}`, pathname: '/', search: '?x=1' }
  const rows = consumeProfileHandoff({ location: loc, history: { replaceState: (_a, _b, u) => { replaced = u } } })
  assert.equal(rows.length, 2)
  assert.ok(replaced, '必须清理地址栏')
  assert.doesNotMatch(replaced, /ph=/)
  assert.match(replaced, /^\//)
})

test('没有交接参数时不动地址栏', () => {
  let called = false
  const rows = consumeProfileHandoff({ location: { hash: '', pathname: '/', search: '' }, history: { replaceState: () => { called = true } } })
  assert.deepEqual(rows, [])
  assert.equal(called, false)
})

test('数量上限 12，防止 URL 过长', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `p${i}`, apiBase: `http://h${i}:8787` }))
  assert.equal(decodeProfileHandoff(encodeProfileHandoff(many)).length, 12)
})
