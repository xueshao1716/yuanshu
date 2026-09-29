import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as manager from '../../engine/session-manager.mjs'
import { createPiCompatFallback } from '../../engine/pi-compat-fallback.mjs'
import { initSessionFiles, invalidateSessionCache } from '../../engine/session-files.mjs'
import { createVoiceTaskDelivery } from '../../engine/voice-task-delivery.mjs'
import { deliverTask } from '../../engine/voice-task-scheduler.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t, { waitAgent = false, waitSummary = false, lazyNewSession = false, failFirstAgent = false, onCreated = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-lifecycle-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sessionsDir = path.join(root, 'sessions', 'workspace')
  const { SessionManager: Fallback } = createPiCompatFallback({ agentDir: root })
  const agentStarted = deferred(), agentRelease = deferred(), summaryStarted = deferred(), summaryRelease = deferred()
  const agents = [], active = new Map()
  let opens = 0, created = null
  const SessionManager = {
    create(cwd, dir) {
      created = Fallback.create(cwd, dir)
      if (lazyNewSession) {
        created.fileEntries = created.getFileEntries()
        created.getHeader = () => created.fileEntries[0]
        fs.unlinkSync(created.getSessionFile()); created.appendSessionInfo = () => {}; created.flushed = false
        const append = created.appendMessage.bind(created)
        created.appendMessage = message => {
          if (!created.flushed) fs.writeFileSync(created.getSessionFile(), created.fileEntries.map(JSON.stringify).join('\n') + '\n', { flag: 'wx' })
          const result = append(message); created.flushed = true; return result
        }
      }
      return created
    },
    open(file, dir, cwd) {
      opens++
      const sm = Fallback.open(file, dir, cwd)
      // The SDK exposes these two compaction hooks; storage remains real temp JSONL.
      sm.fileEntries = sm.getFileEntries()
      sm._rewriteFile = () => fs.writeFileSync(file, sm.fileEntries.map(JSON.stringify).join('\n') + '\n')
      return sm
    },
  }
  const origin = Fallback.create(root, sessionsDir), id = origin.getSessionId(), file = origin.getSessionFile()
  for (let i = 0; i < 10; i++) origin.appendMessage({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })
  initSessionFiles({ sessionsDir, workspaceCwd: root })
  invalidateSessionCache()
  manager.initSessionManager({ cwd: root, sessionsDir, activeSessions: active, SessionManager,
    getDefaultModel: () => ({ provider: 'fixture', id: 'fixture', contextWindow: 100000 }), getModelList: () => [],
    getAgentDir: () => root, readJsonFile: () => ({}), writeJsonFile: () => {},
    onSessionCreated: onCreated || (() => {}),
    agentFactory: async () => {
      const agent = { disposed: 0, dispose() { this.disposed++ } }
      agents.push(agent); agentStarted.resolve()
      if (failFirstAgent && agents.length === 1) throw new Error('agent_initialization_failed')
      if (waitAgent) await agentRelease.promise
      return agent
    },
    summaryFetch: async () => {
      summaryStarted.resolve()
      if (waitSummary) await summaryRelease.promise
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'fixture summary' } }] }) }
    },
  })
  return { root, id, file, origin, active, agents, agentStarted, agentRelease, summaryStarted, summaryRelease,
    opens: () => opens, created: () => created }
}

test('concurrent openSession calls share one entry and one agent construction', async t => {
  const f = fixture(t)
  const [a, b] = await Promise.all([manager.openSession(f.id), manager.openSession(f.id)])
  assert.equal(a, b)
  assert.equal(f.agents.length, 1)
  assert.equal(f.opens(), 1)
})

test('delete during opening never recreates the file or caches an entry', async t => {
  const f = fixture(t)
  const opening = manager.openSession(f.id)
  await manager.deleteSession(f.id)
  assert.equal(await opening, null)
  assert.equal(f.active.has(f.id), false)
  assert.equal(fs.existsSync(f.file), false)
})

test('deletion disposes a late agent and invalidates a replaced generation', async t => {
  const f = fixture(t, { waitAgent: true }), saved = fs.readFileSync(f.file, 'utf8')
  const opening = manager.openSession(f.id)
  await f.agentStarted.promise
  await manager.deleteSession(f.id)
  fs.writeFileSync(f.file, saved)
  f.agentRelease.resolve()
  assert.equal(await opening, null)
  assert.equal(f.agents[0].disposed, 1)
  assert.equal(f.active.has(f.id), false)
})

for (const change of ['delete', 'mutate']) test(`compact does not overwrite after ${change} during summary`, async t => {
  const f = fixture(t, { waitSummary: true })
  const compacting = manager.compactSession(f.file, {}, true)
  await f.summaryStarted.promise
  if (change === 'delete') await manager.deleteSession(f.id)
  else f.origin.appendMessage({ role: 'user', content: 'must survive' })
  const expected = change === 'delete' ? null : fs.readFileSync(f.file, 'utf8')
  f.summaryRelease.resolve()
  const result = await compacting
  assert.equal(result.skip, true)
  assert.equal(fs.existsSync(f.file), change !== 'delete')
  if (expected) assert.equal(fs.readFileSync(f.file, 'utf8'), expected)
  assert.equal(fs.existsSync(f.file + '.bak'), false)
})

test('withIdleSession defers busy/opening/compacting/rebuilding and evicts only an idle agent', async t => {
  const f = fixture(t, { waitAgent: true, waitSummary: true })
  assert.equal(typeof manager.withIdleSession, 'function')
  let appended = 0
  const append = sm => { appended++; return sm.appendMessage({ role: 'assistant', content: 'delivered' }) }
  const busy = () => assert.throws(() => manager.withIdleSession(f.id, append), { code: 'session_busy' })
  const opening = manager.openSession(f.id)
  busy()
  await f.agentStarted.promise
  busy()
  f.agentRelease.resolve()
  const entry = await opening
  entry.busy = true; busy(); entry.busy = false
  const compacting = manager.compactSession(f.file, {}, true)
  await f.summaryStarted.promise
  busy()
  f.summaryRelease.resolve(); await compacting
  entry.agent = null
  const rebuilding = manager.ensureAgent(entry)
  busy(); await rebuilding
  assert.equal(appended, 0)
  const agent = entry.agent, result = manager.withIdleSession(f.id, append)
  assert.ok(result.id)
  assert.equal(result?.then, undefined)
  assert.equal(f.active.has(f.id), false)
  assert.equal(agent.disposed, 1)
  await manager.deleteSession(f.id)
  assert.deepEqual(manager.withIdleSession(f.id, append), { code: 'conversation_gone' })
  assert.equal(appended, 1)
})

test('ensureAgent is singleflight and cannot attach an agent after deletion', async t => {
  const f = fixture(t, { waitAgent: true })
  const entry = { sm: f.origin, agent: null, busy: false }
  f.active.set(f.id, entry)
  const first = manager.ensureAgent(entry), second = manager.ensureAgent(entry)
  const outcomes = Promise.allSettled([first, second])
  await f.agentStarted.promise
  await manager.deleteSession(f.id)
  f.agentRelease.resolve()
  const results = await outcomes
  assert.equal(f.agents.length, 1)
  assert.equal(f.agents[0].disposed, 1)
  assert.equal(entry.agent, null)
  for (const result of results) assert.equal(result.reason?.code, 'conversation_gone')
})

test('delete during create prevents late cache insertion and session info writes', async t => {
  const f = fixture(t, { waitAgent: true })
  const creating = manager.createSession('should not reappear')
  const outcome = Promise.allSettled([creating])
  await f.agentStarted.promise
  const id = f.created().getSessionId(), file = f.created().getSessionFile()
  await manager.deleteSession(id)
  f.agentRelease.resolve()
  const [result] = await outcome
  assert.equal(result.reason?.code, 'conversation_gone')
  assert.equal(f.active.has(id), false)
  assert.equal(fs.existsSync(file), false)
  assert.equal(f.agents[0].disposed, 1)
})

test('SDK lazily persisted new sessions retain their agent and can rebuild', async t => {
  const f = fixture(t, { lazyNewSession: true })
  const id = await manager.createSession('lazy SDK session'), entry = f.active.get(id)
  assert.equal(fs.existsSync(entry.sm.getSessionFile()), false)
  assert.equal(await manager.ensureAgent(entry), entry.agent)
  entry.agent = null
  assert.ok(await manager.ensureAgent(entry))
  await manager.deleteSession(id)
  await assert.rejects(manager.ensureAgent(entry), { code: 'conversation_gone' })
})

test('a rejected agent initialization releases singleflight and idle delivery locks', async t => {
  const f = fixture(t, { failFirstAgent: true })
  await assert.rejects(manager.openSession(f.id), /agent_initialization_failed/)
  assert.ok(manager.withIdleSession(f.id, sm => sm.appendMessage({ role: 'assistant', content: 'still deliverable' })).id)
  assert.ok(await manager.openSession(f.id))
  assert.equal(f.agents.length, 2)
})

test('deletion while the created-session hook awaits cannot return a live session', async t => {
  const hookStarted = deferred(), hookRelease = deferred()
  const f = fixture(t, { onCreated: async () => { hookStarted.resolve(); await hookRelease.promise } })
  const creating = manager.createSession('delete during hook'), outcome = Promise.allSettled([creating])
  await hookStarted.promise
  const id = f.created().getSessionId(), file = f.created().getSessionFile()
  await manager.deleteSession(id)
  hookRelease.resolve()
  const [result] = await outcome
  assert.equal(result.reason?.code, 'conversation_gone')
  assert.equal(f.active.has(id), false)
  assert.equal(fs.existsSync(file), false)
  assert.equal(f.agents[0].disposed, 1)
})

test('known live lazy origins receive durable scheduler delivery without permanent blocking', async t => {
  const f = fixture(t, { lazyNewSession: true }), id = await manager.createSession('lazy delivery')
  const entry = f.active.get(id), file = entry.sm.getSessionFile()
  const task = { id: 'lazy-task', conversationId: id, status: 'completed', title: 'lazy result' }
  const deliver = createVoiceTaskDelivery({ withSession: manager.withIdleSession })
  await deliverTask(task, { id: 'run' }, { canAccess: () => true, readResult: () => ({ summary: 'result' }), deliver, save() {} })
  assert.equal(task.delivery.status, 'delivered')
  assert.equal(fs.existsSync(file), true)
  assert.equal(entry.agent.disposed, 1)
  assert.equal(f.active.has(id), false)
  assert.ok(entry.sm.getFileEntries().some(row => row.customType === 'voice-task-delivery'))
  assert.deepEqual(deliver(task, { summary: 'result' }, task.delivery.id), { messageId: task.delivery.messageId })
})

test('lazy origin allowance ends at first persistence even if its file then disappears', async t => {
  const f = fixture(t, { lazyNewSession: true }), id = await manager.createSession('persist once')
  const entry = f.active.get(id), file = entry.sm.getSessionFile()
  entry.sm.appendMessage({ role: 'assistant', content: 'persisted' })
  fs.unlinkSync(file)
  let appended = false
  assert.deepEqual(manager.withIdleSession(id, () => { appended = true }), { code: 'conversation_gone' })
  await assert.rejects(manager.ensureAgent(entry), { code: 'conversation_gone' })
  assert.equal(appended, false)
  assert.equal(fs.existsSync(file), false)
})

test('busy lazy origins defer while deleted lazy origins cannot be resurrected', async t => {
  const f = fixture(t, { lazyNewSession: true }), id = await manager.createSession('busy lazy')
  const entry = f.active.get(id), file = entry.sm.getSessionFile()
  entry.busy = true
  assert.throws(() => manager.withIdleSession(id, () => {}), { code: 'session_busy' })
  entry.busy = false
  await manager.deleteSession(id)
  assert.deepEqual(manager.withIdleSession(id, () => {}), { code: 'conversation_gone' })
  // Even a stale holder reinserting the former entry cannot restore lazy authority.
  f.active.set(id, entry)
  assert.deepEqual(manager.withIdleSession(id, () => {}), { code: 'conversation_gone' })
  assert.equal(fs.existsSync(file), false)
})

test('lazy write allowance never covers an unrelated missing session manager', async t => {
  const f = fixture(t)
  fs.unlinkSync(f.file)
  f.active.set(f.id, { sm: f.origin, busy: false, agent: null })
  let appended = false
  assert.deepEqual(manager.withIdleSession(f.id, () => { appended = true }), { code: 'conversation_gone' })
  assert.equal(appended, false)
  assert.equal(fs.existsSync(f.file), false)
})

test('lazy rebuilding origin defers delivery and wrong active-map identity cannot borrow its allowance', async t => {
  const f = fixture(t, { lazyNewSession: true }), id = await manager.createSession('identity and rebuild')
  const entry = f.active.get(id)
  entry.agent = null
  const rebuilding = manager.ensureAgent(entry)
  assert.throws(() => manager.withIdleSession(id, () => {}), { code: 'session_busy' })
  await rebuilding
  f.active.set('wrong-session-id', entry)
  assert.deepEqual(manager.withIdleSession('wrong-session-id', () => {}), { code: 'conversation_gone' })
  assert.equal(fs.existsSync(entry.sm.getSessionFile()), false)
})
