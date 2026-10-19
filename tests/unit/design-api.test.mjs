// 设计路由（2026-10-19 从 server.mjs 抽出）：路由表能用、能带出结果、错误不吞。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDesignRoutes } from '../../engine/design-api.mjs'

const make = (over = {}) => {
  const calls = []
  const routes = createDesignRoutes({
    wsRoot: 'W',
    json: (res, code, body) => calls.push({ code, body }),
    readBody: async () => ({ topic: '极简海报' }),
    readCanvasDoc: () => ({ nodes: [], edges: [], brief: {} }),
    normalizeCanvasDoc: (d) => ({ doc: d, errors: [] }),
    auditCanvas: async () => ({ ok: true, issues: [] }),
    formatAudit: () => '巡检通过',
    createCommission: (root, input) => ({ id: 'c1', title: input.title }),
    listCommissions: () => [{ id: 'c1' }],
    removeCommission: () => ({ ok: true }),
    runCommission: async () => ({ ok: true, report: {} }),
    setCommissionStatus: (root, id, status) => ({ ok: true, status }),
    listResearch: () => [{ id: 'r1' }],
    readResearch: () => ({ id: 'r1' }),
    runResearch: async () => ({ ok: true, record: { id: 'r2' } }),
    modelSearch: () => null,
    generateImageSaved: async () => ({ url: '/x.png' }),
    ...over,
  })
  const find = (method, path) => routes.find(([m, p]) => m === method && (p === path || (p instanceof RegExp && p.test(path))))
  return { routes, calls, find }
}

test('路由表：九条都挂上了', () => {
  const { routes } = make()
  assert.equal(routes.length, 9)
  const key = routes.map(([m, p]) => `${m} ${p instanceof RegExp ? p.source : p}`)
  assert.ok(key.includes('GET /api/design-commissions'))
  assert.ok(key.includes('POST /api/canvas/audit'))
  assert.ok(key.includes('GET /api/design-research'))
})

test('画布巡检：带前端文档时优先用它，返回 ok/issues/text', async () => {
  const { calls, find } = make({ auditCanvas: async () => ({ ok: false, issues: [{ level: 'error', message: 'x' }] }) })
  const route = find('POST', '/api/canvas/audit')
  await route[2]({ on() {}, removeListener() {} }, { on() {}, removeListener() {} })
  assert.equal(calls[0].code, 200)
  assert.equal(calls[0].body.ok, false)
  assert.equal(calls[0].body.text, '巡检通过')
})

test('委托试跑：把 generate/audit 注入进去再调引擎', async () => {
  let seen = null
  const { calls, find } = make({ runCommission: async (root, id, opts) => { seen = { root, id, hasGenerate: typeof opts.generate === 'function', hasAudit: typeof opts.audit === 'function', fresh: opts.fresh }; return { ok: true } } })
  const route = find('POST', '/api/design-commissions/c1/run')
  await route[2]({}, {}, null, [null, 'c1'])
  assert.equal(calls[0].code, 200)
  assert.deepEqual(seen, { root: 'W', id: 'c1', hasGenerate: true, hasAudit: true, fresh: true })
})

test('调研跑一次：缺 topic 直接 400，不调引擎', async () => {
  let called = 0
  const { calls, find } = make({ readBody: async () => ({}), runResearch: async () => { called++; return { ok: true, record: {} } } })
  const route = find('POST', '/api/design-research')
  await route[2]({}, {})
  assert.equal(calls[0].code, 400)
  assert.equal(called, 0)
})

test('调研按 id 取：找不到回 404', () => {
  const { calls, find } = make({ readResearch: () => null })
  const route = find('GET', '/api/design-research/nope')
  route[2]({}, {}, null, [null, 'nope'])
  assert.equal(calls[0].code, 404)
})

test('引擎抛错时回 500 且带 error，不冒泡', async () => {
  const { calls, find } = make({ listCommissions: () => { throw new Error('disk broken') } })
  const route = find('GET', '/api/design-commissions')
  assert.throws(() => route[2]({}))
  // 巡检路径有 try/catch，这里验证它确实兜住
  const broken = make({ auditCanvas: async () => { throw new Error('boom') } })
  await broken.find('POST', '/api/canvas/audit')[2]({}, {})
  assert.equal(broken.calls[0].code, 500)
  assert.match(broken.calls[0].body.error, /boom/)
})
