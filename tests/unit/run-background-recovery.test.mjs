import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createRunEffects, hashArgs } from '../../engine/run-effects.mjs'
import { createRunManager } from '../../engine/run-manager.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const checkpoint = () => {
  const messages = [{ role: 'user', content: 'finish this task' }]
  return { checkpointKind: 'tool_results', turn: 2, toolPlan: [], pendingSteps: [], uncertainSteps: [],
    historySnapshot: { v: 1, turn: 2, messages, digest: hashArgs(messages) } }
}
const emit = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
function fixture(executeChat) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-background-'))
  const store = createRunStore({ rootDir })
  const eventLog = createRunEventLog({ rootDir })
  const effects = createRunEffects({ rootDir })
  const scheduled = []
  let scope = rootDir
  const options = { store, eventLog, effects, executeChat, instanceId: 'owner-a', workspaceScope: () => scope,
    scheduleRecovery: callback => { const item = { callback, cancelled: false }; scheduled.push(item); return () => { item.cancelled = true } } }
  const manager = createRunManager(options)
  const create = (extra = {}) => manager.create({ sessionId: 's1', clientRequestId: 'r1', message: 'finish this task', ...extra })
  return { rootDir, store, eventLog, effects, manager, options, create, scheduled,
    setScope: value => { scope = value },
    async next() { const item = scheduled.shift(); assert.ok(item, 'automatic recovery was scheduled'); if (!item.cancelled) item.callback(); await tick() },
    cleanup() { manager.dispose?.(); eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) } }
}
function pause(_req, res) { emit(res, 'checkpoint', checkpoint()); emit(res, 'interrupted', { reason: 'execution_budget' }); res.end() }

test('budget pause continues from durable checkpoint without an intermediate terminal event', async () => {
  const contexts = []
  const fx = fixture((req, res, body) => { contexts.push(body.__runContext); if (contexts.length === 1) pause(req, res); else res.end() })
  try {
    const run = fx.create(); await tick()
    const queued = fx.store.get(run.id)
    assert.equal(queued.status, 'queued')
    assert.equal(queued.backgroundRecovery.used, 1)
    assert.equal(fx.manager.readAfter(run.id, 0).some(e => e.type === 'interrupted'), false)
    await fx.next()
    assert.equal(fx.store.get(run.id).status, 'completed')
    assert.equal(contexts[1].resume, true)
    assert.deepEqual(contexts[1].checkpoint.historySnapshot, checkpoint().historySnapshot)
    assert.ok(contexts[1].executionBudgetMs > 0 && contexts[1].executionBudgetMs <= 30 * 60_000)
  } finally { fx.cleanup() }
})

test('manual continuation after an automatic timeout gets a fresh bounded slice', async () => {
  const contexts = []
  const fx = fixture((req, res, body) => {
    contexts.push(body.__runContext)
    if (contexts.length === 1) return pause(req, res)
    if (contexts.length === 2) emit(res, 'error', { message: 'network timeout' })
    res.end()
  })
  try {
    const run = fx.create(); await tick(); await fx.next()
    const failed = fx.store.get(run.id)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.resumeAvailable, true)
    const expired = { ...failed.backgroundRecovery, deadlineAt: '2000-01-01T00:00:00.000Z' }
    fx.store.update(run.id, { backgroundRecovery: expired })
    fx.manager.resume(run.id); await tick()
    assert.equal(contexts[2].executionBudgetMs, 30 * 60_000)
    assert.ok(contexts[2].executionDeadlineAt > Date.now())
    assert.equal(fx.store.get(run.id).status, 'completed')
    assert.equal(fx.store.get(run.id).backgroundRecovery.used, 1)
    assert.equal(fx.store.get(run.id).backgroundRecovery.deadlineAt, expired.deadlineAt)
    assert.equal(fx.scheduled.length, 0)
  } finally { fx.cleanup() }
})

test('automatic continuation still caps its slice to the remaining recovery window', async () => {
  const contexts = []
  const fx = fixture((req, res, body) => { contexts.push(body.__runContext); if (contexts.length === 1) pause(req, res); else res.end() })
  try {
    const run = fx.create(); await tick()
    const deadlineAt = new Date(Date.now() + 60_000).toISOString()
    fx.store.update(run.id, { backgroundRecovery: { ...fx.store.get(run.id).backgroundRecovery, deadlineAt } })
    await fx.next()
    assert.ok(contexts[1].executionBudgetMs > 0 && contexts[1].executionBudgetMs <= 60_000)
    assert.ok(contexts[1].executionDeadlineAt <= Date.parse(deadlineAt))
    assert.equal(fx.store.get(run.id).status, 'completed')
  } finally { fx.cleanup() }
})

test('automatic recovery is bounded to three continuations and retains manual continuation', async () => {
  const fx = fixture(pause)
  try {
    const run = fx.create(); await tick()
    for (let i = 0; i < 3; i++) await fx.next()
    const result = fx.store.get(run.id)
    assert.equal(result.status, 'interrupted')
    assert.equal(result.backgroundRecovery.used, 3)
    assert.equal(result.backgroundRecovery.reason, 'limit_reached')
    assert.equal(result.resumeAvailable, true)
    assert.equal(fx.scheduled.length, 0)
  } finally { fx.cleanup() }
})

test('stop while recovery is queued cancels continuation and cannot revive after restart', async () => {
  let calls = 0
  const fx = fixture((req, res) => { calls++; pause(req, res) })
  try {
    const run = fx.create(); await tick(); fx.manager.stop(run.id); await fx.next()
    createRunManager({ ...fx.options, instanceId: 'owner-b' }).recover()
    await tick()
    assert.equal(calls, 1)
    assert.equal(fx.store.get(run.id).status, 'stopped')
  } finally { fx.cleanup() }
})

test('explicit disable cancels queued continuation without restarting the task', async () => {
  const fx = fixture(pause)
  try {
    const run = fx.create(); await tick(); fx.manager.disableRecovery(run.id); await fx.next()
    assert.equal(fx.store.get(run.id).backgroundRecovery.enabled, false)
    assert.equal(fx.store.get(run.id).status, 'interrupted')
  } finally { fx.cleanup() }
})

for (const [name, change, reason] of [
  ['pending approval', fx => fx.store.update(fx.runId, { approvalRequired: true }), 'approval_required'],
  ['uncertain side effect', fx => fx.effects.markUncertain(fx.runId, 'unsafe'), 'effects_uncertain'],
  ['in-flight side effect', fx => fx.effects.begin(fx.runId, 'unsafe'), 'effects_uncertain'],
  ['corrupt ledger', fx => fs.writeFileSync(path.join(fx.rootDir, 'effects', `${fx.runId}.json`), '{'), 'effects_unavailable'],
  ['corrupt snapshot', fx => fx.store.saveCheckpoint(fx.runId, { historySnapshot: { ...checkpoint().historySnapshot, digest: 'wrong' } }), 'checkpoint_invalid'],
  ['changed workspace', fx => fx.setScope(path.join(fx.rootDir, 'another-project')), 'scope_changed'],
  ['expired deadline', fx => fx.store.update(fx.runId, { backgroundRecovery: { ...fx.store.get(fx.runId).backgroundRecovery, deadlineAt: '2000-01-01T00:00:00.000Z' } }), 'deadline_reached'],
  ['team task', fx => fx.store.saveCheckpoint(fx.runId, { team: { general: { inFlight: { role: 'EXEC' } } } }), 'team_requires_review'],
]) test(`queued recovery revalidates ${name}`, async () => {
  const fx = fixture(pause)
  try {
    fx.runId = fx.create().id; await tick(); change(fx); await fx.next()
    assert.equal(fx.store.get(fx.runId).status, 'interrupted')
    assert.equal(fx.store.get(fx.runId).backgroundRecovery.reason, reason)
  } finally { fx.cleanup() }
})

test('confirm events persist an approval barrier before any recovery can be scheduled', async () => {
  const fx = fixture((req, res) => { emit(res, 'confirm', { id: 'approval' }); pause(req, res) })
  try {
    const run = fx.create(); await tick()
    assert.equal(fx.store.get(run.id).approvalRequired, true)
    assert.equal(fx.scheduled.length, 0)
    assert.equal(fx.store.get(run.id).backgroundRecovery.reason, 'approval_required')
  } finally { fx.cleanup() }
})

test('recovery never opts historical runs in and preserves user stop intent', () => {
  const fx = fixture(pause)
  try {
    const old = fx.store.create({ sessionId: 'old', clientRequestId: 'old', message: 'old', ownerId: 'old' })
    const stopping = fx.store.create({ sessionId: 'stop', clientRequestId: 'stop', message: 'stop', ownerId: 'old' })
    fx.store.update(stopping.id, { status: 'stopping', stopRequestedAt: new Date().toISOString() })
    fx.manager.recover()
    assert.equal(fx.store.get(old.id).status, 'interrupted')
    assert.equal(fx.store.get(stopping.id).status, 'stopped')
    assert.equal(fx.scheduled.length, 0)
  } finally { fx.cleanup() }
})

test('restart reuses a scheduled recovery reservation instead of charging it twice', async () => {
  const fx = fixture(pause)
  try {
    const run = fx.create(); await tick(); fx.manager.dispose?.(); fx.scheduled.length = 0
    const restarted = createRunManager({ ...fx.options, instanceId: 'owner-b', executeChat: (_req, res) => res.end() })
    restarted.recover(); await fx.next()
    assert.equal(fx.store.get(run.id).backgroundRecovery.used, 1)
    assert.equal(fx.store.get(run.id).status, 'completed')
    restarted.dispose?.()
  } finally { fx.cleanup() }
})

test('legacy stopping state remains stopped even without a stop timestamp', () => {
  const fx = fixture(pause)
  try {
    const old = fx.store.create({ sessionId: 'old', clientRequestId: 'old', message: 'old', ownerId: 'old' })
    fx.store.update(old.id, { status: 'stopping' })
    fx.manager.recover()
    assert.equal(fx.store.get(old.id).status, 'stopped')
    assert.equal(fx.scheduled.length, 0)
  } finally { fx.cleanup() }
})

test('same request stays idempotent and a different session cannot consume its checkpoint', async () => {
  const seen = []
  const fx = fixture((req, res, body) => { seen.push([body.sessionId, body.__runContext.runId]); pause(req, res) })
  try {
    const first = fx.create(); await tick()
    assert.equal(fx.create().id, first.id)
    const other = fx.create({ sessionId: 's2' }); await tick()
    await fx.next()
    assert.deepEqual(seen, [['s1', first.id], ['s2', other.id], ['s1', first.id]])
    assert.equal(fx.store.get(other.id).backgroundRecovery.used, 1)
  } finally { fx.cleanup() }
})
