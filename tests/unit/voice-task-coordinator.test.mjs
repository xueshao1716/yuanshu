import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createRunManager } from '../../engine/run-manager.mjs'
const module = await import('../../engine/voice-task-coordinator.mjs').catch(() => ({}))
const advance = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const tasks = [{ title: 'Draft', instruction: 'Write the draft' }, { title: 'Review', instruction: 'Review it', dependsOn: [0] }]
test('idle voice polling never scans run history or rewrites an empty journal', async t => {
  const f = await fixture(t)
  let scans = 0
  const list = f.manager.list
  f.manager.list = () => { scans++; return list() }
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.coordinator.tick(), [])
  assert.equal(scans, 0, 'one-second polling must not scan every historical run while idle')
  assert.equal(fs.existsSync(path.join(f.rootDir, 'voice-tasks', 'journal.json')), false)
})

test('known running tasks poll their own run rather than all historical runs', async t => {
  const f = await fixture(t)
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'running', tasks: [tasks[0]] })
  await f.coordinator.tick()
  let scans = 0
  const list = f.manager.list
  f.manager.list = () => { scans++; return list() }
  const [running] = await f.coordinator.tick()
  assert.equal(running.status, 'running'); assert.equal(scans, 0)
  await f.finish(running); await f.coordinator.tick()
  assert.equal(scans, 0); assert.equal(f.receipts.length, 1)
})

test('delivered task history remains read-only during idle recovery polling', async t => {
  const f = await fixture(t)
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'idle', tasks: [tasks[0]] })
  await f.coordinator.tick(); await f.finish((await f.coordinator.list('origin'))[0]); await f.coordinator.tick()
  const file = path.join(f.rootDir, 'voice-tasks', 'journal.json'), before = fs.statSync(file)
  let scans = 0
  const list = f.manager.list
  f.manager.list = () => { scans++; return list() }
  const listed = await f.coordinator.tick()
  assert.equal(listed[0].delivery.status, 'delivered')
  assert.equal(scans, 0)
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs)
})

async function fixture(t, overrides = {}) {
  assert.equal(typeof module.createVoiceTaskCoordinator, 'function', 'coordinator factory must exist')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanshu-voice-'))
  const store = createRunStore({ rootDir }), eventLog = createRunEventLog({ rootDir })
  const executions = [], receipts = [], sessions = [], peers = [], pending = new Map()
  const manager = createRunManager({ store, eventLog, instanceId: 'test', executeChat: async (req, res, body) => {
    peers.push(req.socket.remoteAddress); executions.push(body); await new Promise(resolve => { pending.set(body.sessionId, resolve); req.on('close', resolve) }); res.end()
  } })
  const options = { rootDir, manager, createSession: async task => { sessions.push(task.sessionId); return task.sessionId },
    canAccess: () => true, readResult: async run => ({ status: run.status, summary: 'Done' }),
    deliver: async (task, result, id) => { receipts.push({ task, result, id }); return { messageId: id } },
    policy: { model: 'server-model', maxConcurrency: 4 }, ...overrides }
  const make = () => module.createVoiceTaskCoordinator(options)
  t.after(async () => { for (const resolve of pending.values()) resolve(); await advance(); manager.dispose(); eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) })
  return { rootDir, store, manager, options, make, coordinator: make(), executions, receipts, sessions, peers,
    finish: async task => { pending.get(task.sessionId)?.(); await advance() } }
}
test('durable replay preserves IDs, isolates origins, and rejects changed content', async t => {
  const f = await fixture(t), input = { conversationId: 'origin', requestId: 'r1', tasks }
  const group = await f.coordinator.submit(input)
  assert.equal(group.tasks.length, 2); assert.notEqual(group.tasks[0].sessionId, group.tasks[1].sessionId)
  assert.match(group.tasks[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.deepEqual(await f.make().submit(input), group)
  await assert.rejects(f.coordinator.submit({ ...input, tasks: [{ title: 'Changed', instruction: 'Changed' }] }), { code: 'request_conflict' })
  const other = await f.coordinator.submit({ ...input, conversationId: 'other' })
  assert.notEqual(other.tasks[0].id, group.tasks[0].id)
  assert.equal((await f.coordinator.list('origin')).length, 2)
  for (const invalid of [[{ ...tasks[0], model: 'client-model' }], [{ ...tasks[0], dependsOn: [0] }], Array(9).fill(tasks[0])])
    await assert.rejects(f.coordinator.submit({ ...input, requestId: 'bad', tasks: invalid }), { code: 'invalid_request' })
})
test('singleflight ticks serialize unknown tools including unrelated runs and gate dependencies', async t => {
  const f = await fixture(t), outside = f.manager.create({ sessionId: 'outside', clientRequestId: 'outside', message: 'work', backgroundRecovery: false })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks })
  await Promise.all([f.coordinator.tick(), f.coordinator.tick()]); assert.equal(f.manager.list().length, 1)
  await f.finish(outside); await Promise.all([f.coordinator.tick(), f.coordinator.tick()])
  let listed = await f.coordinator.list('origin'); assert.equal(f.executions.length, 2); assert.equal(listed[1].status, 'queued')
  assert.equal(f.executions[1].model, 'server-model'); assert.equal(f.executions[1].backgroundRecovery, false)
  assert.equal(f.peers[1], '0.0.0.0', 'missing policy context never gains localhost privileges')
  await f.finish(listed[0]); await f.coordinator.tick(); listed = await f.coordinator.list('origin')
  assert.equal(listed[0].status, 'completed'); assert.equal(f.receipts.length, 1); assert.equal(f.executions.length, 3)
  await f.finish(listed[1]); await f.make().tick(); assert.equal(f.receipts.length, 2)
})
test('restart reconciles run created before journal receipt and never relaunches uncertain work', async t => {
  const f = await fixture(t); await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks: [tasks[0]] })
  const file = path.join(f.rootDir, 'voice-tasks', 'journal.json'), journal = JSON.parse(fs.readFileSync(file, 'utf8'))
  const task = journal.groups[0].tasks[0]; task.sessionReady = true; task.launchAttempted = true
  fs.writeFileSync(file, JSON.stringify(journal))
  const run = f.manager.create({ sessionId: task.sessionId, clientRequestId: task.id, message: task.instruction, backgroundRecovery: false })
  await f.make().tick(); assert.equal((await f.make().list('origin'))[0].runId, run.id); assert.equal(f.executions.length, 1)
  await f.finish(task); fs.rmSync(path.join(f.rootDir, 'runs', run.id + '.json'))
  await f.make().tick(); assert.equal((await f.make().list('origin'))[0].status, 'interrupted'); assert.equal(f.executions.length, 1)
})
test('trusted policy permits only disjoint named resources and recreates execution context', async t => {
  const f = await fixture(t, { policy: { maxConcurrency: 2, resourceForTask: task => task.title, context: task => ({ socket: { remoteAddress: task.conversationId } }) } })
  await f.coordinator.submit({ conversationId: 'remote-peer', requestId: 'r1', tasks: [tasks[0], { title: 'Other', instruction: 'Work independently' }, tasks[0]] })
  await Promise.all([f.coordinator.tick(), f.coordinator.tick(), f.coordinator.submit({ conversationId: 'other', requestId: 'r2', tasks: [tasks[0]] })])
  assert.equal(f.executions.length, 2); assert.deepEqual(f.peers, ['remote-peer', 'remote-peer'])
  assert.equal((await f.coordinator.list('remote-peer'))[2].status, 'queued')
})
test('delivery retry after restart keeps stable receipt and never repeats execution', async t => {
  let attempts = 0; const seen = new Set()
  const f = await fixture(t, { deliver: async (_task, _result, id) => { seen.add(id); if (++attempts === 1) throw Error('receipt-write-lost'); return { messageId: id } } })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks: [tasks[0]] }); await f.coordinator.tick()
  await f.finish((await f.coordinator.list('origin'))[0]); await f.coordinator.tick()
  await f.make().tick(); await f.make().tick()
  assert.equal(attempts, 2); assert.equal(seen.size, 1); assert.equal(f.executions.length, 1)
  assert.equal((await f.make().list('origin'))[0].delivery.status, 'delivered')
})
test('failed dependency blocks descendants and interrupted runs never automatically replay', async t => {
  const f = await fixture(t); await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks }); await f.coordinator.tick()
  const first = (await f.coordinator.list('origin'))[0]; f.store.update(first.runId, { status: 'interrupted' })
  await f.finish(first); await f.make().tick(); await f.make().tick()
  assert.deepEqual((await f.make().list('origin')).map(task => task.status), ['interrupted', 'blocked'])
  assert.equal(f.executions.length, 1); assert.equal(f.receipts.length, 2)
})
test('stop is origin-scoped and queued stop never executes', async t => {
  const f = await fixture(t); const group = await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks })
  await assert.rejects(f.coordinator.stop('other', group.tasks[0].id), { code: 'task_not_found' })
  await f.coordinator.stop('origin', group.tasks[1].id); await f.coordinator.tick()
  await f.coordinator.stop('origin', group.tasks[0].id); await advance(); await f.coordinator.tick()
  assert.deepEqual((await f.coordinator.list('origin')).map(task => task.status), ['stopped', 'stopped'])
  assert.equal(f.executions.length, 1)
})
test('deleted origin blocks delivery permanently and never recreates or reroutes', async t => {
  let accessible = true
  const f = await fixture(t, { canAccess: () => accessible })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks: [tasks[0]] }); await f.coordinator.tick()
  await f.finish((await f.coordinator.list('origin'))[0]); accessible = false; await f.coordinator.tick()
  await assert.rejects(f.coordinator.list('origin'), { code: 'conversation_gone' })
  accessible = true; await f.make().tick()
  assert.equal(f.receipts.length, 0); assert.equal(f.sessions.length, 1)
  assert.equal((await f.make().list('origin'))[0].delivery.status, 'blocked')
})
test('origin deleted while result loads is checked again before receipt append', async t => {
  let accessible = true
  const f = await fixture(t, { canAccess: () => accessible, readResult: async run => { accessible = false; return { status: run.status } } })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'r1', tasks: [tasks[0]] }); await f.coordinator.tick()
  await f.finish((await f.coordinator.list('origin'))[0]); await f.coordinator.tick()
  assert.equal(f.receipts.length, 0)
  accessible = true; assert.equal((await f.make().list('origin'))[0].delivery.status, 'blocked')
})
test('admission rechecks unrelated runs after awaited session preparation', async t => {
  const gate = deferred(), entered = deferred()
  const f = await fixture(t, { createSession: async task => { entered.resolve(); await gate.promise; return task.sessionId } })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'late', tasks: [tasks[0]] })
  const ticking = f.coordinator.tick(); await entered.promise
  const outside = f.manager.create({ sessionId: 'late-outsider', clientRequestId: 'external', message: 'outside', backgroundRecovery: false })
  gate.resolve(); await ticking
  assert.equal(f.manager.list().length, 1, 'voice launch must defer to unknown run admitted while session setup awaited')
  assert.equal((await f.coordinator.list('origin'))[0].status, 'queued')
  await f.finish(outside); await f.coordinator.tick(); assert.equal(f.manager.list().length, 2)
})
for (const stage of ['readResult', 'deliver']) test(stage + ' cannot lock submit/list/stop or other scheduling', async t => {
  const gate = deferred(), entered = deferred()
  let blockedSession
  const overrides = { [stage]: async item => { if (item.sessionId === blockedSession) { entered.resolve(); await gate.promise }; return stage === 'deliver' ? { messageId: 'receipt' } : { summary: 'done' } } }
  const f = await fixture(t, overrides)
  const group = await f.coordinator.submit({ conversationId: 'origin', requestId: 'slow', tasks })
  blockedSession = group.tasks[0].sessionId
  await f.coordinator.tick(); await f.finish((await f.coordinator.list('origin'))[0])
  const ticking = f.coordinator.tick(); await entered.promise
  let listed = false, submitted = false, stopped = false
  const operations = [f.coordinator.list('origin').then(() => { listed = true }),
    f.coordinator.submit({ conversationId: 'new-origin', requestId: 'new', tasks: [tasks[0]] }).then(() => { submitted = true }),
    f.coordinator.stop('origin', group.tasks[1].id).then(() => { stopped = true })]
  try {
    for (let i = 0; i < 4; i++) await advance()
    assert.deepEqual([listed, submitted, stopped], [true, true, true], 'slow adapter I/O must not own the journal lock')
    await f.make().tick(); assert.equal(f.executions.length, 3, 'new-origin runs while receipt remains pending')
  } finally { gate.resolve(); await ticking; await Promise.all(operations) }
  assert.equal((await f.coordinator.list('new-origin')).length, 1, 'delivery persistence must not overwrite concurrent submit')
  assert.equal((await f.coordinator.list('origin'))[1].status, 'stopped', 'delivery persistence must not overwrite stop')
})

for (const operation of ['submit', 'list', 'stop']) test(operation + ' reauthorizes at the journal boundary', async t => {
  const f = await fixture(t)
  const group = await f.coordinator.submit({ conversationId: 'origin', requestId: 'original', tasks: [tasks[0]] })
  let accessible = true
  f.options.canAccess = () => { const result = accessible; queueMicrotask(() => { accessible = false }); return result }
  const coordinator = f.make()
  const action = operation === 'submit' ? () => coordinator.submit({ conversationId: 'origin', requestId: 'late', tasks })
    : operation === 'stop' ? () => coordinator.stop('origin', group.tasks[0].id) : () => coordinator.list('origin')
  await assert.rejects(action(), { code: 'conversation_gone' })
  const journal = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'voice-tasks', 'journal.json'), 'utf8'))
  assert.equal(journal.groups.length, 1)
  assert.equal(journal.groups[0].tasks[0].status, 'queued')
})

test('origin disappearing after execution precheck cannot admit a run', async t => {
  let accessible = true, checks = 0
  const f = await fixture(t, { canAccess: (_origin, action) => {
    if (action === 'execute' && ++checks === 2) queueMicrotask(() => { accessible = false })
    return accessible
  } })
  await f.coordinator.submit({ conversationId: 'origin', requestId: 'late', tasks: [tasks[0]] })
  await f.coordinator.tick()
  assert.equal(f.manager.list().length, 0)
  assert.equal(f.executions.length, 0)
})

test('asynchronous origin authorizers fail closed', async t => {
  const f = await fixture(t, { canAccess: async () => true })
  await assert.rejects(f.coordinator.submit({ conversationId: 'origin', requestId: 'async', tasks }), { code: 'async_origin_authorization' })
})
