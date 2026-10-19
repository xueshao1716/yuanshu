// 模型自带联网搜索（2026-10-19）：模型给候选 → 我们逐条验活。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildResearchPrompt, extractJsonRows, verifySources } from '../../engine/model-research.mjs'

test('提示词禁止编链接，允许平台检索入口', () => {
  const p = buildResearchPrompt('极简海报')
  assert.match(p, /禁止编造/)
  assert.match(p, /检索入口/)
})

test('抽 JSON 数组：容忍代码围栏与前后废话', () => {
  const text = '好的，结果如下：\n```json\n[{"title":"A","url":"https://a.com/x","snippet":"摘要"}]\n```\n希望有用。'
  const rows = extractJsonRows(text)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].url, 'https://a.com/x')
  assert.equal(extractJsonRows('没有 JSON 的回复').length, 0)
  assert.equal(extractJsonRows('[{"title":"坏","url":"example.com"}]').length, 0, '非 http 地址要丢')
})

test('验活：打不开、非网页的都丢掉，只留能打开的', async () => {
  const rows = [
    { title: 'ok', url: 'https://a.com/x', snippet: '' },
    { title: 'dead', url: 'https://dead.example/x', snippet: '' },
    { title: 'pdf', url: 'https://b.com/x.pdf', snippet: '' },
    { title: 'dup', url: 'https://a.com/x', snippet: '' },
  ]
  const fetchImpl = async (url) => {
    if (url.includes('dead')) return { ok: false, status: 404, headers: new Map() }
    if (url.includes('pdf')) return { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]) }
    return { ok: true, status: 200, headers: new Map([['content-type', 'text/html; charset=utf-8']]) }
  }
  const out = await verifySources(rows, { fetchImpl })
  assert.deepEqual(out.map((r) => r.title), ['ok'])
  assert.equal(out[0].site, 'a.com')
  assert.equal(out[0].verified, true)
})

test('全部打不开时返回空数组，不编造成功', async () => {
  const out = await verifySources([{ title: 'x', url: 'https://x.com/1', snippet: '' }], { fetchImpl: async () => { throw new Error('net') } })
  assert.equal(out.length, 0)
})
