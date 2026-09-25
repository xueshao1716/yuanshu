import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skillEpisodesFromSessions } from '../../engine/dream.mjs'
import { createRunStore } from '../../engine/run-store.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-intake-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessionsDir = path.join(root, 'sessions')
  fs.mkdirSync(sessionsDir)
  return { root, sessionsDir }
}
async function collector(options) {
  const mod = await import('../../engine/dream-collector.mjs').catch(() => ({}))
  assert.equal(typeof mod.createDreamCollector, 'function', 'needs retry-safe collector')
  return mod.createDreamCollector(options)
}
test('strict session extraction reports read and malformed JSON errors', () => {
  assert.throws(() => skillEpisodesFromSessions(['missing'], { strict: true, readFile: () => { throw Error('unreadable') } }), /unreadable/)
  assert.throws(() => skillEpisodesFromSessions(['partial'], { strict: true, readFile: () => '{broken' }), /JSON/)
})
test('collector persists per-file progress, retries failure at equal timestamp after restart', async t => {
  const { root, sessionsDir } = fixture(t)
  for (const name of ['a', 'b']) { const f = path.join(sessionsDir, `${name}.jsonl`); fs.writeFileSync(f, '{}\n'); fs.utimesSync(f, 100, 100) }
  let fail = true; const calls = []
  const options = { wsRoot: root, sessionsDir, extract: files => { calls.push(path.basename(files[0])); return [{ kind: 'x', input: path.basename(files[0]) }] },
    append: (_, eps) => fail && eps[0].input === 'a.jsonl' ? { ok: false, error: 'disk full' } : { ok: true, added: 1 } }
  let c = await collector(options)
  const first = await c.collect()
  assert.equal(first.failed, 1); assert.equal(first.succeeded, 1)
  fail = false; c = await collector(options)
  assert.equal(c.status().failed, 1)
  const next = await c.collect()
  assert.equal(next.failed, 0); assert.equal(next.skipped, 1)
  assert.deepEqual(calls, ['a.jsonl', 'b.jsonl', 'a.jsonl'])
  const idle = await c.collect()
  assert.equal(idle.reason, 'no_changes'); assert.equal(idle.scanned, 0)
})
test('collector coalesces concurrent calls and does not acknowledge changing files', async t => {
  const { root, sessionsDir } = fixture(t)
  const file = path.join(sessionsDir, 'a.jsonl'); fs.writeFileSync(file, '{}\n')
  let calls = 0
  const c = await collector({ wsRoot: root, sessionsDir, extract: async () => { calls++; await new Promise(r => setImmediate(r)); fs.appendFileSync(file, '{}\n'); return [] }, append: () => ({ ok: true, added: 0 }) })
  const [a, b] = await Promise.all([c.collect(), c.collect()])
  assert.equal(calls, 1); assert.equal(a.failed, 1); assert.deepEqual(a, b)
})
test('collector reports missing directory and corrupt state without overwriting evidence', async t => {
  const { root, sessionsDir } = fixture(t)
  fs.rmdirSync(sessionsDir)
  const c = await collector({ wsRoot: root, sessionsDir })
  assert.equal((await c.collect()).ok, false)
  fs.mkdirSync(sessionsDir)
  fs.writeFileSync(c.stateFile, '{broken')
  await assert.rejects(c.collect(), /JSON/)
  assert.equal(fs.readFileSync(c.stateFile, 'utf8'), '{broken')
})
test('completed runs enter persistent bounded candidates once, without approval or cross-workspace mixing', async t => {
  const { root } = fixture(t)
  const mod = await import('../../engine/learning-intake.mjs').catch(() => ({}))
  assert.equal(typeof mod.createLearningIntake, 'function', 'needs local candidate queue')
  let id = 0; const store = createRunStore({ rootDir: root, idFactory: () => `r${++id}` })
  const complete = (scope = root) => { const r = store.create({ sessionId: 's', clientRequestId: `c${id}`, message: 'test token=secret', backgroundRecovery: { scope } }); return store.update(r.id, { status: 'completed', completedAt: new Date().toISOString() }) }
  let service = mod.createLearningIntake({ wsRoot: root, store, limit: 2 })
  const one = complete(); service.enqueue(one); service.enqueue(one)
  assert.equal(service.status().count, 1)
  assert.equal(service.status().entries[0].state, 'pending')
  assert.ok(!JSON.stringify(service.status()).includes('secret'))
  service.enqueue(complete(path.join(root, 'other')))
  assert.equal(service.status().count, 1)
  service.enqueue(complete()); service.enqueue(complete())
  service = mod.createLearningIntake({ wsRoot: root, store, limit: 2 })
  await service.reconcile()
  assert.equal(service.status().count, 2)
  assert.ok(!service.status().entries.some(e => e.runId === one.id), 'pruned records must not re-enter')
  assert.equal(store.get(one.id).learningIntake.state, 'queued')
  const failed = complete(); store.update(failed.id, { status: 'failed' })
  service.enqueue(store.get(failed.id)); assert.equal(service.status().count, 2)
})
test('candidate persistence failure is visible and reconciliation retries without duplication', async t => {
  const { root } = fixture(t)
  const { createLearningIntake } = await import('../../engine/learning-intake.mjs')
  const store = createRunStore({ rootDir: root })
  const r = store.create({ sessionId: 's', clientRequestId: 'c', message: 'work', backgroundRecovery: { scope: root } })
  store.update(r.id, { status: 'completed' })
  const service = createLearningIntake({ wsRoot: root, store })
  const dir = path.join(root, '记忆', '运行时'); fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, '待提炼任务.json'); fs.writeFileSync(file, '{broken')
  await service.reconcile()
  assert.equal(store.get(r.id).learningIntake.state, 'failed')
  assert.equal(service.status().ok, false)
  assert.equal(service.status().backlog, 1)
  assert.equal(service.status().failed, 1)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  fs.unlinkSync(file)
  await service.reconcile(); await service.reconcile()
  assert.equal(service.status().count, 1)
  assert.equal(store.get(r.id).learningIntake.state, 'queued')
  assert.equal(service.status().backlog, 0)
})
