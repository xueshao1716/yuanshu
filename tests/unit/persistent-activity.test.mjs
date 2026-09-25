import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRunStore } from '../../engine/run-store.mjs'

test('activity rebuilds from persistent runs and ignores unscoped or foreign records', async t => {
  const mod = await import('../../engine/persistent-activity.mjs').catch(() => ({}))
  assert.equal(typeof mod.buildPersistentActivity, 'function', 'needs durable activity projection')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-activity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = createRunStore({ rootDir: root })
  const r = store.create({ sessionId: 's', clientRequestId: 'c', message: 'create token=secret', backgroundRecovery: { scope: root } })
  store.update(r.id, { status: 'completed', completedAt: '2026-09-25T10:00:00Z', observability: { engine: 'yuanshu' } })
  store.create({ sessionId: 's2', clientRequestId: 'c2', message: 'private' })
  const result = mod.buildPersistentActivity(createRunStore({ rootDir: root }).list(), root)
  assert.equal(result.events.length, 1); assert.equal(result.activeCount, 0)
  assert.equal(result.events[0].source, 'run-ledger')
  assert.equal(result.events[0].type, 'completed')
  assert.equal(result.events[0].data.engine, 'yuanshu')
  assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('private'))
})
test('activity bounds rows but computes active count independently of last historical event', async () => {
  const { buildPersistentActivity } = await import('../../engine/persistent-activity.mjs')
  const runs = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, sessionId: 's', status: i === 0 ? 'running' : 'completed', updatedAt: i + 1, backgroundRecovery: { scope: 'D:/test' } }))
  const result = buildPersistentActivity(runs, 'D:/test', 40)
  assert.equal(result.events.length, 40); assert.equal(result.activeCount, 1)
})

test('resumed activity uses current timestamp, not stale failure timestamp', async () => {
  const { buildPersistentActivity } = await import('../../engine/persistent-activity.mjs')
  const result = buildPersistentActivity([{ id: 'r', status: 'running', failedAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z', backgroundRecovery: { scope: 'D:/test' } }], 'D:/test')
  assert.equal(result.events[0].ts, '2026-09-25T00:00:00Z')
})
