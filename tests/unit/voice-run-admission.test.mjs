import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRunManager } from '../../engine/run-manager.mjs'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
const advance = () => new Promise(resolve => setImmediate(resolve))
const body = id => ({ sessionId: id, clientRequestId: id, message: 'Work', backgroundRecovery: false })
const claim = (resourceKey = null, maxConcurrency = 2) => ({ voiceTaskAdmission: { resourceKey, maxConcurrency } })
function fixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-admission-'))
  const store = createRunStore({ rootDir }), eventLog = createRunEventLog({ rootDir })
  const pending = new Set(), managers = []
  const make = instanceId => {
    const manager = createRunManager({ store, eventLog, instanceId, executeChat: async (req, res) => {
      await new Promise(resolve => { pending.add(resolve); req.once('close', resolve) }); res.end()
    } }); managers.push(manager); return manager
  }
  const manager = make('first')
  t.after(async () => { for (const release of pending) release(); await advance(); for (const m of managers) m.dispose(); eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) })
  return { manager, store, make }
}
test('unknown voice scope excludes later ordinary runs without creating a rejected run', async t => {
  const f = fixture(t), first = f.manager.create(body('voice'), claim())
  assert.throws(() => f.manager.create(body('chat')), { code: 'run_capacity' })
  assert.equal(f.manager.list().length, 1)
  assert.equal(f.manager.create(body('voice'), claim()).id, first.id, 'replay still returns original receipt')
  await advance(); f.manager.stop(first.id); await advance()
  assert.equal(f.manager.create(body('chat')).status, 'queued')
  await advance()
})
test('existing ordinary run prevents voice launch but ordinary-only behavior is unchanged', async t => {
  const f = fixture(t)
  f.manager.create(body('a')); f.manager.create(body('b'))
  assert.throws(() => f.manager.create(body('voice'), claim('isolated')), { code: 'run_capacity' })
  assert.equal(f.manager.list().length, 2); await advance()
})
test('trusted disjoint resources run together within the strictest shared limit', async t => {
  const f = fixture(t)
  f.manager.create(body('a'), claim('repo-a', 2))
  assert.throws(() => f.manager.create(body('same'), claim('repo-a')), { code: 'run_capacity' })
  f.manager.create(body('b'), claim('repo-b', 4))
  assert.throws(() => f.manager.create(body('c'), claim('repo-c', 8)), { code: 'run_capacity' })
  assert.throws(() => f.manager.create(body('ordinary')), { code: 'run_capacity' })
  assert.equal(f.manager.list().length, 2); await advance()
})
test('request-body admission claims cannot masquerade as isolated server context', async t => {
  const f = fixture(t)
  f.manager.create({ ...body('ordinary'), ...claim('forged') })
  assert.equal(f.manager.list()[0].voiceTaskAdmission, undefined)
  assert.throws(() => f.manager.create(body('voice'), claim('other')), { code: 'run_capacity' })
  await advance()
})
test('admission survives manager reconstruction and cannot be weakened by resume', async t => {
  const f = fixture(t), paused = f.manager.create(body('voice'), claim(null, 1))
  await advance(); f.manager.stop(paused.id); await advance()
  f.store.update(paused.id, { status: 'interrupted', resumeAvailable: true })
  const next = f.make('second')
  next.create(body('ordinary'))
  assert.throws(() => next.resume(paused.id, claim('pretend-isolated', 8)), { code: 'run_capacity' })
  assert.equal(next.get(paused.id).status, 'interrupted'); await advance()
})
test('persisted active voice admission protects all newly created managers', async t => {
  const f = fixture(t)
  f.manager.create(body('voice'), claim())
  assert.throws(() => f.make('second').create(body('ordinary')), { code: 'run_capacity' })
  await advance()
})
