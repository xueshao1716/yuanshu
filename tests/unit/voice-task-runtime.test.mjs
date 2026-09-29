import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createRunManager } from '../../engine/run-manager.mjs'
import { voiceRuntimeFixture, advance } from '../helpers/voice-runtime-fixture.mjs'
const runtimeModule = await import('../../engine/voice-task-runtime.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
const apiModule = await import('../../engine/voice-task-api.mjs').catch(e => { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {} })
const task = { title: '生成小报告', instruction: '生成隔离验收文件' }
function fixture(t) {
  assert.equal(typeof runtimeModule.createVoiceTaskRuntime, 'function', 'runtime factory must exist')
  assert.equal(typeof apiModule.createVoiceTaskApi, 'function', 'text API factory must exist')
  const f = voiceRuntimeFixture(t, runtimeModule.createVoiceTaskRuntime), runtime = f.make()
  let bodyReads = 0
  const api = apiModule.createVoiceTaskApi({ runtime, authorize: req => req.headers.authorization === 'Bearer test-only',
    readBody: async req => { bodyReads++; return req.body }, json: (res, status, body) => Object.assign(res, { status, body }) })
  const request = body => Object.assign(new EventEmitter(), { headers: { authorization: 'Bearer test-only', 'x-pi-test': '1' }, socket: { remoteAddress: '127.0.0.1' }, body })
  return { ...f, runtime, api, request, bodyReads: () => bodyReads }
}
test('authorized text handoff survives client close and delivers evidence only to its origin', async t => {
  const f = fixture(t), req = f.request({ conversationId: f.id, requestId: 'text-1', tasks: [task] }), res = {}
  await f.api.submit(res, req)
  assert.equal(res.status, 202)
  const group = res.body.group, item = group.tasks[0]
  assert.equal(item.runId, null); assert.equal(item.status, 'queued'); assert.equal(item.requirementRevision, 1)
  req.emit('close'); await f.runtime.tick()
  let [running] = await f.runtime.list(f.id)
  assert.equal(running.status, 'running'); assert.notEqual(running.sessionId, f.id)
  assert.equal(f.executions[0].body.model, 'server-owned-model')
  assert.equal(f.executions[0].body.backgroundRecovery, false)
  assert.equal(f.executions[0].req.headers['x-pi-test'], undefined)
  assert.equal(f.executions[0].req.socket.remoteAddress, '0.0.0.0')
  assert.equal(f.executions[0].req.destroyed, false)
  await f.finish(running); await f.runtime.tick()
  const [finished] = await f.runtime.list(f.id), result = finished.delivery.result
  assert.equal(finished.delivery.status, 'delivered')
  assert.equal(result.acceptance, 'pending'); assert.equal(result.artifacts.length, 1)
  assert.equal(result.artifacts[0].url, '/api/ws/file?path=' + encodeURIComponent('生成物/' + running.sessionId + '.json'))
  const messages = f.rows().filter(row => row.message?.voiceTaskId === item.id)
  assert.equal(messages.length, 1)
  const text = messages[0].message.content[0].text
  for (const expected of ['需求版本：1', '隔离执行器已生成结果', '验证', '未完成项', '待验收', result.artifacts[0].url, '/api/runs/' + running.runId]) assert.ok(text.includes(expected), expected)
  assert.deepEqual(f.notices, [f.id])
  const restored = f.make(); await restored.tick(); await restored.tick()
  assert.equal(f.executions.length, 1); assert.equal(f.rows().filter(row => row.message?.voiceTaskId === item.id).length, 1)
  assert.match(finished.delivery.id, /-r1-v1$/)
})
test('runtime accepts the actual server model descriptor without forwarding credentials', async t => {
  const f = fixture(t), runtime = f.make({ getModel: () => ({ provider: 'test-provider', id: 'text-model', apiKey: 'must-not-forward' }) })
  await runtime.submit({ conversationId: f.id, requestId: 'server-model', tasks: [task] }); await runtime.tick()
  assert.equal(f.executions.length, 1, 'the server default model is a descriptor, not a string')
  assert.equal(f.executions[0].body.model, 'test-provider/text-model')
  assert.ok(!JSON.stringify(f.executions[0].body).includes('must-not-forward'))
})
test('text APIs reject unauthenticated calls, client policy injection and foreign stop', async t => {
  const f = fixture(t)
  for (const method of ['submit', 'list', 'stop']) {
    const req = f.request({ conversationId: f.id, requestId: 'bad', tasks: [task] }); req.headers = {}
    const res = {}; await f.api[method](res, req, method === 'list' ? new URL('http://test/?conversationId=' + f.id) : 'unknown')
    assert.equal(res.status, 401)
  }
  assert.equal(f.bodyReads(), 0); assert.equal(f.manager.list().length, 0)
  for (const extra of [{ model: 'fake' }, { context: { socket: { remoteAddress: '127.0.0.1' } } }, { confirmed: true }]) {
    const res = {}; await f.api.submit(res, f.request({ conversationId: f.id, requestId: 'bad', tasks: [task], ...extra }))
    assert.equal(res.status, 400)
  }
  const group = await f.runtime.submit({ conversationId: f.id, requestId: 'scoped', tasks: [task] })
  const denied = {}; await f.api.stop(denied, f.request({ conversationId: 'missing-origin' }), group.tasks[0].id)
  assert.equal(denied.status, 404)
  const stopped = {}; await f.api.stop(stopped, f.request({ conversationId: f.id }), group.tasks[0].id)
  assert.equal(stopped.status, 200); assert.equal(stopped.body.task.status, 'stopped')
  await f.runtime.tick(); assert.equal(f.executions.length, 0)
})
test('busy origin defers receipt and restart retries delivery without another execution', async t => {
  const f = fixture(t)
  await f.runtime.submit({ conversationId: f.id, requestId: 'busy', tasks: [task] }); await f.runtime.tick()
  const [running] = await f.runtime.list(f.id); await f.finish(running)
  f.active.set(f.id, { sm: f.origin, busy: true }); await f.runtime.tick()
  assert.equal((await f.runtime.list(f.id))[0].delivery.status, 'pending')
  assert.equal(f.rows().filter(r => r.message).length, 0)
  f.active.clear(); f.runtime.close(); await f.make().tick()
  assert.equal((await f.runtime.list(f.id))[0].delivery.status, 'delivered'); assert.equal(f.executions.length, 1)
})
test('delayed receipt rechecks evidence and does not publish a deleted artifact as available', async t => {
  const f = fixture(t)
  await f.runtime.submit({ conversationId: f.id, requestId: 'changed-artifact', tasks: [task] }); await f.runtime.tick()
  const [running] = await f.runtime.list(f.id); await f.finish(running)
  f.active.set(f.id, { sm: f.origin, busy: true }); await f.runtime.tick()
  const [pending] = await f.runtime.list(f.id)
  assert.equal(pending.delivery.result.artifacts.length, 1)
  fs.unlinkSync(path.join(f.cwd, pending.delivery.result.artifacts[0].path))
  f.active.clear(); await f.make().tick()
  const [delivered] = await f.runtime.list(f.id)
  assert.equal(delivered.delivery.status, 'delivered'); assert.equal(f.executions.length, 1)
  assert.equal(delivered.delivery.result.artifacts.length, 0)
  const message = f.rows().find(row => row.message?.voiceTaskId === running.id).message.content[0].text
  assert.ok(!message.includes('/api/ws/file?'))
  assert.ok(message.includes('结构检查：FAIL'))
})
test('new run manager recovers a pending receipt from disk without executing again', async t => {
  const f = fixture(t)
  await f.runtime.submit({ conversationId: f.id, requestId: 'manager-restart', tasks: [task] }); await f.runtime.tick()
  const [running] = await f.runtime.list(f.id); await f.finish(running)
  f.active.set(f.id, { sm: f.origin, busy: true }); await f.runtime.tick()
  assert.equal((await f.runtime.list(f.id))[0].delivery.status, 'pending')
  f.runtime.close(); f.manager.dispose(); f.eventLog.close(); f.active.clear()
  const store = createRunStore({ rootDir: f.rootDir }), eventLog = createRunEventLog({ rootDir: f.rootDir })
  let repeated = 0
  const manager = createRunManager({ store, eventLog, instanceId: 'restarted-test', executeChat: async () => { repeated++ } })
  t.after(() => { manager.dispose(); eventLog.close() })
  assert.deepEqual(manager.recover(), [])
  const restored = f.make({ manager }); await restored.tick(); await restored.tick()
  const [delivered] = await restored.list(f.id)
  assert.equal(delivered.runId, running.runId); assert.equal(delivered.delivery.status, 'delivered')
  assert.equal(repeated, 0); assert.equal(manager.list().length, 1)
  assert.equal(f.rows().filter(row => row.message?.voiceTaskId === running.id).length, 1)
})
test('lost receipt acknowledgement recovers the already appended evidence without duplication', async t => {
  const f = fixture(t)
  let loseAcknowledgement = true
  const runtime = f.make({ withSession: (id, callback) => {
    const receipt = f.options.withSession(id, callback)
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('simulated lost receipt acknowledgement') }
    return receipt
  } })
  await runtime.submit({ conversationId: f.id, requestId: 'lost-receipt', tasks: [task] }); await runtime.tick()
  const [running] = await runtime.list(f.id); await f.finish(running); await runtime.tick()
  assert.equal((await runtime.list(f.id))[0].delivery.status, 'pending')
  const saved = f.rows().find(row => row.message?.voiceTaskId === running.id)
  assert.ok(saved.message.voiceTaskResult.artifacts.length)
  fs.unlinkSync(path.join(f.cwd, saved.message.voiceTaskResult.artifacts[0].path))
  await f.make().tick()
  const [delivered] = await runtime.list(f.id)
  assert.equal(delivered.delivery.status, 'delivered'); assert.equal(delivered.delivery.messageId, saved.id)
  assert.deepEqual(delivered.delivery.result, saved.message.voiceTaskResult)
  assert.equal(f.rows().filter(row => row.message?.voiceTaskId === running.id).length, 1)
  assert.equal(f.executions.length, 1)
})
test('recovery timer starts explicitly and close releases it without cancelling work', async t => {
  const f = fixture(t)
  await f.runtime.submit({ conversationId: f.id, requestId: 'timer', tasks: [task] })
  await advance(); assert.equal(f.executions.length, 0)
  f.runtime.start(); f.runtime.start()
  for (let i = 0; i < 50 && !f.executions.length; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.executions.length, 1)
  const [running] = await f.runtime.list(f.id)
  f.runtime.close(); await f.finish(running)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.rows().filter(r => r.message).length, 0)
  await f.make().tick(); assert.equal(f.rows().filter(r => r.message).length, 1)
})
test('deleted origin is not recreated by runtime recovery', async t => {
  const f = fixture(t)
  await f.runtime.submit({ conversationId: f.id, requestId: 'deleted', tasks: [task] }); await f.runtime.tick()
  const [running] = await f.runtime.list(f.id); fs.unlinkSync(f.file); await f.finish(running); await f.make().tick()
  assert.equal(fs.existsSync(f.file), false); assert.deepEqual(f.notices, [])
  const journal = JSON.parse(fs.readFileSync(path.join(f.rootDir, 'voice-tasks/journal.json'), 'utf8'))
  assert.equal(journal.groups[0].tasks[0].delivery.status, 'blocked')
})

test('four accepted tasks serialize unknown resources, retain dependencies and cancel independently', async t => {
  const f = fixture(t)
  const group = await f.runtime.submit({ conversationId: f.id, requestId: 'four', tasks: [task,
    { title: '独立任务', instruction: '第二份文件' }, { title: '依赖任务', instruction: '完成后执行', dependsOn: [0] },
    { title: '冲突任务', instruction: '同一工作区先排队' }] })
  assert.equal(group.tasks.length, 4); assert.equal(new Set(group.tasks.map(item => item.sessionId)).size, 4)
  await f.runtime.tick(); assert.equal(f.executions.length, 1)
  await f.runtime.stop(f.id, group.tasks[3].id)
  for (let i = 0; i < 3; i++) {
    const listed = await f.runtime.list(f.id), running = listed.find(item => item.status === 'running')
    assert.ok(running); await f.finish(running); await f.runtime.tick()
  }
  const listed = await f.runtime.list(f.id)
  assert.deepEqual(listed.map(item => item.status), ['completed', 'completed', 'completed', 'stopped'])
  assert.ok(listed.every(item => item.delivery.status === 'delivered'))
  assert.equal(f.executions.length, 3); assert.equal(f.rows().filter(r => r.message?.voiceTaskId).length, 4)
})

test('worker is revalidated after queued session setup and before execution', async t => {
  const f = fixture(t)
  const outside = f.manager.create({ sessionId: 'outside', clientRequestId: 'outside', message: 'hold', backgroundRecovery: false })
  const group = await f.runtime.submit({ conversationId: f.id, requestId: 'worker-check', tasks: [task] })
  const journalPath = path.join(f.rootDir, 'voice-tasks/journal.json'), journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
  journal.groups[0].tasks[0].sessionReady = true
  fs.writeFileSync(journalPath, JSON.stringify(journal))
  await advance(); await f.finish(outside); await f.runtime.tick()
  const [item] = await f.runtime.list(f.id)
  assert.equal(item.status, 'blocked', 'missing prepared worker must not be silently recreated')
  assert.equal(f.executions.length, 1)
  assert.equal(fs.existsSync(path.join(f.sessionsDir, group.tasks[0].sessionId + '.jsonl')), false)
})

test('server mounts authenticated voice APIs and starts runtime only after run recovery', () => {
  const source = fs.readFileSync(new URL('../../server.mjs', import.meta.url), 'utf8')
  // Source contracts must not depend on single versus double quote style.
  const lines = source.split('\n').map(line => line.replaceAll('"', "'"))
  for (const signature of ["'POST', '/api/voice/tasks'", "'GET', '/api/voice/tasks'"]) {
    assert.ok(lines.some(line => line.includes(signature) && line.includes('voiceTaskApi.')), signature)
  }
  assert.ok(lines.some(line => line.includes('voiceTaskApi.stop') && line.includes('stop')))
  assert.ok(lines.some(line => line.includes('createVoiceTaskApi(') && line.includes('authorize: authorizeVoiceTask')))
  assert.ok(lines.some(line => line.includes('createVoiceTaskAuthorizer(') && line.includes('origins: voiceOrigins')))
  const recovery = source.indexOf('const recoveredRuns = runManager.recover();'), start = source.indexOf('voiceTaskRuntime.start();')
  assert.ok(start > recovery && recovery > source.indexOf('server.listen('))
  assert.ok(lines.some(line => line.includes("server.on('close'") && line.includes('voiceTaskRuntime.close()')))
})
