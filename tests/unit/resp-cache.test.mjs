// 响应级 TTL 缓存（2026-09-20 抽出，并修一次真实事故）
//
// 事故：/api/run/overview 的返回**依赖 ?session=**，而缓存键原来是固定字符串。
// 结果同一时刻用 session=A / session=B / 不传 请求，拿到的是同一份 A 的数据；
// 前端按当前会话在 recent 里找不到自己的 run → 聊天页底部的运行状态/工具交互显示整块消失。
// 所以这里锁三条不变量：①键含查询串；②同键同串命中缓存（handler 只跑一次）；
// ③不同串各自成键，互不串味。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createWithCache } from '../../engine/resp-cache.mjs'

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, h) { this.statusCode = code; this.headers = { ...this.headers, ...(h || {}) } },
    setHeader(k, v) { this.headers[k] = v },
    getHeader(k) { return this.headers[k] },
    end(b) { if (b !== undefined) this.body = String(b) },
    headersSent: false,
  }
}
const urlOf = (s) => new URL('http://x/api/run/overview' + s)

test('实时会话查询绕过缓存，刚启动的任务立即可见，总览仍缓存', async () => {
  let active = []
  let calls = 0
  const wrapped = createWithCache()(60000, 'run-overview', res => {
    calls++; res.end(JSON.stringify({ active }))
  }, { bypass: (_req, url) => url.searchParams.has('session') })
  const before = fakeRes(); await wrapped(before, {}, urlOf('?session=A'))
  active = [{ id: 'new-run', sessionId: 'A' }]
  const after = fakeRes(); await wrapped(after, {}, urlOf('?session=A'))
  assert.equal(JSON.parse(after.body).active[0]?.id, 'new-run')
  await wrapped(fakeRes(), {}, urlOf(''))
  await wrapped(fakeRes(), {}, urlOf(''))
  assert.equal(calls, 3)
})

test('真实 HTTP 响应命中后保留业务头和 UTF-8 分段字节', async () => {
  let calls = 0
  const wrapped = createWithCache()(60000, 'http', res => {
    calls++
    res.setHeader('X-Result', 'fresh')
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    const bytes = Buffer.from('{"text":"你好"}')
    res.write(bytes.subarray(0, 10))
    res.end(bytes.subarray(10))
  })
  const server = http.createServer((req, res) => wrapped(res, req, urlOf('')))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    for (const cache of ['MISS', 'HIT']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`)
      assert.equal(response.headers.get('x-cache'), cache)
      assert.equal(response.headers.get('x-result'), 'fresh')
      assert.deepEqual(await response.json(), { text: '你好' })
    }
    assert.equal(calls, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('失败响应不能缓存成 HTTP 200，恢复后应重新调用', async () => {
  let calls = 0
  const wrapped = createWithCache()(60000, 'errors', res => {
    calls++
    res.writeHead(calls === 1 ? 503 : 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: calls > 1 }))
  })
  const first = fakeRes(); await wrapped(first, {}, urlOf(''))
  const second = fakeRes(); await wrapped(second, {}, urlOf(''))
  assert.equal(first.statusCode, 503)
  assert.equal(calls, 2)
  assert.deepEqual(JSON.parse(second.body), { ok: true })
})

test('maxKeys 是硬上限：未过期条目也必须淘汰最早写入项', async () => {
  let calls = 0
  const wrapped = createWithCache({ maxKeys: 2 })(60000, 'bounded', res => res.end(String(++calls)))
  for (const id of ['a', 'b', 'c', 'a']) await wrapped(fakeRes(), {}, urlOf('?session=' + id))
  assert.equal(calls, 4)
})

test('命中缓存必须保留响应 Content-Type 等业务头', async () => {
  const wrapped = createWithCache()(60000, 'headers', res => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'private', 'X-Result': 'fresh' })
    res.end('{}')
  })
  await wrapped(fakeRes(), {}, urlOf(''))
  const next = fakeRes(); await wrapped(next, {}, urlOf(''))
  assert.equal(next.headers['Cache-Control'], 'private')
  assert.equal(next.headers['X-Result'], 'fresh')
})

test('键必须含查询串：不同 ?session= 不许互相串味（这条就是那次事故的回归）', async () => {
  const withCache = createWithCache()
  let calls = 0
  const handler = async (res, _req, url) => { calls++; res.end(JSON.stringify({ session: url.searchParams.get('session'), n: calls })) }

  const a = fakeRes(); await withCache(60000, 'run-overview', handler)(a, {}, urlOf('?session=A'))
  const b = fakeRes(); await withCache(60000, 'run-overview', handler)(b, {}, urlOf('?session=B'))
  const none = fakeRes(); await withCache(60000, 'run-overview', handler)(none, {}, urlOf(''))

  assert.equal(JSON.parse(a.body).session, 'A')
  assert.equal(JSON.parse(b.body).session, 'B', 'session=B 必须拿到 B 的结果（原来会拿到 A 的）')
  assert.equal(JSON.parse(none.body).session, null)
  assert.equal(calls, 3, '三个不同查询串应各跑一次 handler')
})

test('同键同串必须命中缓存：handler 只跑一次，且带 X-Cache: HIT', async () => {
  const withCache = createWithCache()
  let calls = 0
  const handler = async (res) => { calls++; res.end('body-' + calls) }
  const wrapped = withCache(60000, 'k', handler)

  const r1 = fakeRes(); await wrapped(r1, {}, urlOf('?session=A'))
  const r2 = fakeRes(); await wrapped(r2, {}, urlOf('?session=A'))
  assert.equal(calls, 1, '第二次同样请求应命中缓存')
  assert.equal(r1.body, r2.body)
  assert.equal(r1.headers['X-Cache'], 'MISS')
  assert.equal(r2.headers['X-Cache'], 'HIT')
  assert.ok(Number(r2.headers['X-Cache-Age']) >= 0)
})

test('TTL 过期后必须重算（别把缓存做成永不过期）', async () => {
  const withCache = createWithCache()
  let calls = 0
  const handler = async (res) => { calls++; res.end('v' + calls) }
  const wrapped = withCache(1, 'k', handler) // 1ms
  await wrapped(fakeRes(), {}, urlOf('?session=A'))
  await new Promise(r => setTimeout(r, 10))
  const r = fakeRes(); await wrapped(r, {}, urlOf('?session=A'))
  assert.equal(calls, 2, 'TTL 过期后必须重算')
  assert.equal(r.headers['X-Cache'], 'MISS')
})

test('按会话分键后不会无限堆积：超过上限会清掉过期条目', async () => {
  const withCache = createWithCache({ maxKeys: 3 })
  const handler = async (res) => res.end('x')
  const wrapped = withCache(1, 'k', handler)
  for (let i = 0; i < 6; i++) await wrapped(fakeRes(), {}, urlOf('?session=s' + i))
  await new Promise(r => setTimeout(r, 10))
  const r = fakeRes(); await wrapped(r, {}, urlOf('?session=s9'))
  assert.equal(r.headers['X-Cache'], 'MISS')
})
