// 承诺销账 + 超期搁置（2026-10-18）。
// 真机投诉：「我明确表示不需要了，她一直挂在记忆里当代办。」
// 根因：模型没有销账手段（只有夜间复盘和网页按钮能结清），账只能一直 pending。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  expireStalePromises, promiseExtraExecutors, pendingPromises, pendingPromiseText,
  loadPromises, PROMISE_TOOL_SCHEMAS, PROMISE_STALE_DAYS,
} from '../../engine/promises.mjs'

const DAY = 86400000
const NOW = new Date('2026-10-18T12:00:00.000Z')

function fixture(list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-promise-'))
  fs.mkdirSync(path.join(root, '记忆'), { recursive: true })
  fs.writeFileSync(path.join(root, '记忆', '承诺兑现.json'), JSON.stringify(list, null, 2))
  return root
}
const row = (id, daysAgo, status = 'pending') => ({
  id, at: new Date(NOW.getTime() - daysAgo * DAY).toISOString(), sessionId: 's1',
  text: `承诺-${id}`, due: null, status, evidence: null, closedAt: null,
})

test('超期 pending 转 expired，不再是待办', () => {
  const root = fixture([row('p_old', 20), row('p_new', 1)])
  const r = expireStalePromises(root, { now: NOW })
  assert.equal(r.ok, true)
  assert.equal(r.expired, 1)
  const list = loadPromises(root)
  assert.equal(list.find(p => p.id === 'p_old').status, 'expired')
  assert.equal(list.find(p => p.id === 'p_new').status, 'pending')
  assert.deepEqual(pendingPromises(root, { now: NOW }).map(p => p.id), ['p_new'])
})

test('expired 带可回溯证据，且没有冒充"已兑现"', () => {
  const root = fixture([row('p_old', PROMISE_STALE_DAYS + 1)])
  expireStalePromises(root, { now: NOW })
  const hit = loadPromises(root).find(p => p.id === 'p_old')
  assert.match(hit.evidence, /自动搁置/)
  assert.match(hit.evidence, /未标记已兑现/)
  assert.ok(hit.closedAt)
})

test('未超期的不动，已结清的也不动', () => {
  const root = fixture([row('p_new', 1), row('p_done', 90, 'kept')])
  const r = expireStalePromises(root, { now: NOW })
  assert.equal(r.expired, 0)
  assert.equal(loadPromises(root).find(p => p.id === 'p_done').status, 'kept')
})

test('promise_close 把用户否掉的那条销成 dropped 并留证据', () => {
  const root = fixture([row('p1', 2)])
  const exec = promiseExtraExecutors(root, { now: () => NOW })
  const out = exec.promise_close({ id: 'p1', reason: '这个不用了' })
  assert.equal(out.isError, false)
  const hit = loadPromises(root).find(p => p.id === 'p1')
  assert.equal(hit.status, 'dropped')
  assert.match(hit.evidence, /用户明确不需要/)
  assert.match(hit.evidence, /这个不用了/)
})

test('缺 id / 缺理由 / 编造 id 都被拒，且不改账本', () => {
  const root = fixture([row('p1', 2)])
  const exec = promiseExtraExecutors(root, { now: () => NOW })
  assert.equal(exec.promise_close({}).isError, true)
  assert.equal(exec.promise_close({ id: 'p1' }).isError, true, '没有用户原话不能销账')
  assert.equal(exec.promise_close({ id: 'p_fake', reason: 'x' }).isError, true)
  assert.equal(loadPromises(root)[0].status, 'pending')
})

test('重复销账给出提示而不是报错', () => {
  const root = fixture([row('p1', 2, 'dropped')])
  const out = promiseExtraExecutors(root, { now: () => NOW }).promise_close({ id: 'p1', reason: '再说一次' })
  assert.equal(out.isError, false)
  assert.match(out.text, /已经结清/)
})

test('注入文本带 id，并明确要求用户否决后立刻销账', () => {
  const root = fixture([row('p1', 2)])
  const text = pendingPromiseText(root, { now: NOW })
  assert.match(text, /\[p1\]/, '没有 id 模型就没法调用销账工具')
  assert.match(text, /promise_close/)
  assert.match(text, /立刻用 promise_close/)
})

test('工具 schema 存在且只暴露销账语义', () => {
  const names = PROMISE_TOOL_SCHEMAS.map(s => s.function.name)
  assert.deepEqual(names, ['promise_close'])
  assert.deepEqual(PROMISE_TOOL_SCHEMAS[0].function.parameters.required, ['id', 'reason'])
})
