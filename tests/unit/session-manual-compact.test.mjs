import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as manager from '../../engine/session-manager.mjs'
import { manualCompactFixture } from '../helpers/manual-compact-fixture.mjs'
import { createVoiceTaskDelivery } from '../../engine/voice-task-delivery.mjs'
import { deliverTask } from '../../engine/voice-task-scheduler.mjs'

function deliveryStaysPending(f, id = f.id, entry = f.entry) {
  const file = entry.sm.getSessionFile()
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  let appended = false
  assert.throws(() => manager.withIdleSession(id, () => { appended = true }), { code: 'session_busy' })
  assert.equal(appended, false)
  assert.equal(f.agent.disposed, 0)
  assert.equal(f.active.get(id), entry)
  if (before !== null) assert.equal(fs.readFileSync(file, 'utf8'), before)
}

test('SDK compaction alone blocks delivery without append, disposal, or eviction', t => {
  const f = manualCompactFixture(t)
  f.agent.isCompacting = true
  assert.equal(f.entry.busy, false)
  deliveryStaysPending(f)
})

test('manual compact API protects cached entry before its first await', async t => {
  const f = manualCompactFixture(t), { res, pending } = f.request()
  try { deliveryStaysPending(f) }
  finally { f.release.resolve(); await pending }
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, summary: 'fixture summary' })
})

for (const outcome of ['success', 'failure']) test(`pre-controller SDK wait defers delivery until ${outcome} then retries exactly once`, async t => {
  const f = manualCompactFixture(t, { waitBeforeController: true }), before = fs.readFileSync(f.file, 'utf8')
  if (outcome === 'failure') f.fail(new Error('fixture compaction failed'))
  const task = { id: 'early-result', conversationId: f.id, status: 'completed', title: 'early result' }
  const deliver = createVoiceTaskDelivery({ withSession: manager.withIdleSession })
  const retry = () => deliverTask(task, { id: 'run' }, { canAccess: () => true, readResult: () => ({ summary: 'result' }), deliver, save() {} })
  const { res, pending } = f.request()
  await f.beforeController.promise
  try {
    assert.equal(f.agent.compactCalls, 1)
    assert.equal(f.agent.isCompacting, false)
    assert.equal(f.entry.busy, false)
    await retry()
    assert.equal(task.delivery.status, 'pending')
    assert.equal(task.delivery.error, 'session_busy')
    assert.equal(task.delivery.attempts, 1)
    assert.equal(fs.readFileSync(f.file, 'utf8'), before)
    deliveryStaysPending(f)
    f.controllerRelease.resolve(); await f.started.promise
    assert.equal(f.agent.isCompacting, true)
    deliveryStaysPending(f)
  } finally { f.controllerRelease.resolve(); f.release.resolve(); await pending }
  assert.equal(res.status, outcome === 'success' ? 200 : 500)
  assert.deepEqual(res.body, outcome === 'success' ? { ok: true, summary: 'fixture summary' } : { error: 'fixture compaction failed' })
  assert.equal(f.agent.isCompacting, false)
  await retry()
  assert.equal(task.delivery.status, 'delivered')
  assert.equal(task.delivery.attempts, 2)
  assert.equal(task.delivery.error, undefined)
  assert.equal(f.agent.disposed, 1)
  assert.equal(f.active.has(f.id), false)
  const saved = fs.readFileSync(f.file, 'utf8'), rows = saved.trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(row => row.message?.voiceDeliveryId === task.delivery.id).length, 1)
  const receipts = rows.filter(row => row.customType === 'voice-task-delivery' && row.data?.deliveryId === task.delivery.id)
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].data.messageId, task.delivery.messageId)
  await retry()
  assert.equal(task.delivery.attempts, 2)
  assert.equal(fs.readFileSync(f.file, 'utf8'), saved)
})

test('delete after ensureAgent resolves prevents a stale SDK compact from starting', async t => {
  const f = manualCompactFixture(t), { res, pending } = f.request()
  await Promise.resolve()
  await manager.deleteSession(f.id)
  f.release.resolve(); await pending
  assert.equal(f.agent.compactCalls, 0)
  assert.equal(f.agent.disposed, 1)
  assert.equal(res.status, 404)
  assert.equal(fs.existsSync(f.file), false)
})

test('delete before open continuation cancels a manual compact request', async t => {
  const f = manualCompactFixture(t), { res, pending } = f.request()
  await manager.deleteSession(f.id)
  await pending
  assert.equal(f.agent.compactCalls, 0)
  assert.equal(res.status, 404)
  assert.equal(f.active.has(f.id), false)
})

test('uncached manual compact awaits open without conflicting with its own lifecycle lock', async t => {
  const f = manualCompactFixture(t, { cached: false, waitAgent: true }), { res, pending } = f.request()
  await f.agentStarted.promise
  assert.throws(() => manager.withIdleSession(f.id, () => {}), { code: 'session_busy' })
  f.agentRelease.resolve(); await f.started.promise
  f.release.resolve(); await pending
  assert.equal(res.status, 200)
  assert.equal(f.agent.compactCalls, 1)
})

test('delete while opening disposes the late agent without starting SDK compact', async t => {
  const f = manualCompactFixture(t, { cached: false, waitAgent: true }), { res, pending } = f.request()
  await f.agentStarted.promise
  await manager.deleteSession(f.id)
  f.agentRelease.resolve(); await pending
  assert.equal(f.agent.compactCalls, 0)
  assert.equal(f.agent.disposed, 1)
  assert.equal(res.status, 404)
})

test('manual compact preserves lazy live sessions', async t => {
  const f = manualCompactFixture(t, { lazy: true }), id = await manager.createSession('lazy compact')
  const entry = f.active.get(id), { res, pending } = f.request(id)
  assert.equal(fs.existsSync(entry.sm.getSessionFile()), false)
  try { deliveryStaysPending(f, id, entry) }
  finally { f.release.resolve(); await pending }
  assert.equal(res.status, 200)
  assert.equal(f.agent.compactCalls, 1)
  assert.equal(await manager.ensureAgent(entry), f.agent)
})

test('busy and missing manual compact responses retain their API status and message', async t => {
  const f = manualCompactFixture(t)
  f.entry.busy = true
  const busy = f.request(); await busy.pending
  assert.equal(busy.res.status, 409)
  assert.deepEqual(busy.res.body, { error: '会话正在处理中' })
  const missing = f.request('missing'); await missing.pending
  assert.equal(missing.res.status, 404)
  assert.deepEqual(missing.res.body, { error: '会话不存在' })
  assert.equal(f.agent.compactCalls, 0)
  f.entry.busy = false
  assert.equal(manager.withIdleSession(f.id, () => 'released'), 'released')
})

test('a second manual compact is rejected while the first request is pending', async t => {
  const f = manualCompactFixture(t), first = f.request(), second = f.request()
  f.release.resolve(); await Promise.all([first.pending, second.pending])
  assert.equal(first.res.status, 200)
  assert.equal(second.res.status, 409)
  assert.equal(f.agent.compactCalls, 1)
})

test('deletion during SDK compact disposes it and does not report a successful live session', async t => {
  const f = manualCompactFixture(t), { res, pending } = f.request()
  await f.started.promise
  await manager.deleteSession(f.id)
  await pending
  assert.equal(f.agent.disposed, 1)
  assert.equal(res.status, 404)
  assert.equal(fs.existsSync(f.file), false)
})

test('manual compact can rebuild an agent while preserving its delivery reservation', async t => {
  const f = manualCompactFixture(t, { waitAgent: true })
  f.entry.agent = null
  const { res, pending } = f.request()
  await f.agentStarted.promise
  try { deliveryStaysPending(f) }
  finally { f.agentRelease.resolve(); f.release.resolve(); await pending }
  assert.equal(res.status, 200)
  assert.equal(f.agent.compactCalls, 1)
})

test('delete during rebuilding disposes the late agent without starting SDK compact', async t => {
  const f = manualCompactFixture(t, { waitAgent: true })
  f.entry.agent = null
  const { res, pending } = f.request()
  await f.agentStarted.promise
  await manager.deleteSession(f.id)
  f.agentRelease.resolve(); await pending
  assert.equal(f.agent.compactCalls, 0)
  assert.equal(f.agent.disposed, 1)
  assert.equal(res.status, 404)
})

test('manual API rejects existing SDK compaction and releases only its own reservation', async t => {
  const f = manualCompactFixture(t)
  f.agent.isCompacting = true
  const { res, pending } = f.request(); await pending
  assert.equal(res.status, 409)
  assert.equal(f.agent.compactCalls, 0)
  deliveryStaysPending(f)
  f.agent.isCompacting = false
  assert.equal(manager.withIdleSession(f.id, () => 'released'), 'released')
})
