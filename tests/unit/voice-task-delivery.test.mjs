import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createPiCompatFallback } from '../../engine/pi-compat-fallback.mjs'
import { createVoiceTaskDelivery, ensureVoiceTaskSession } from '../../engine/voice-task-delivery.mjs'
import { createIdleSessionWriter } from '../../engine/idle-session-writer.mjs'
const NL = String.fromCharCode(10)
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-delivery-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { SessionManager } = createPiCompatFallback({ agentDir: root })
  const sessionsDir = path.join(root, 'sessions'), active = new Map()
  const origin = SessionManager.create(root, sessionsDir)
  origin.appendMessage({ role: 'user', content: '请处理这些任务' })
  const id = origin.getSessionId(), file = origin.getSessionFile()
  let locked = false, notices = 0
  const writer = createIdleSessionWriter({ activeSessions: active, SessionManager, cwd: root, sessionsDir,
    findSession: sid => sid === id ? { file } : null, isLocked: () => locked })
  const deliver = createVoiceTaskDelivery({ withSession: writer, notify: () => { notices++ } })
  return { root, sessionsDir, origin, id, file, active, deliver,
    lock: value => { locked = value }, notices: () => notices }
}
test('worker session IDs are durable and origin history is never copied', t => {
  const f = fixture(t), task = { id: randomUUID(), sessionId: randomUUID(), conversationId: f.id, title: '生成报告' }
  const options = { sessionsDir: f.sessionsDir, cwd: f.root }
  assert.equal(ensureVoiceTaskSession(task, options), task.sessionId)
  assert.equal(ensureVoiceTaskSession(task, options), task.sessionId)
  const rows = fs.readFileSync(path.join(f.sessionsDir, task.sessionId + '.jsonl'), 'utf8').trim().split(NL).map(JSON.parse)
  assert.equal(rows[0].version, 3); assert.equal(rows[0].id, task.sessionId)
  assert.equal(rows.filter(row => row.type === 'message').length, 0)
  assert.throws(() => ensureVoiceTaskSession({ ...task, sessionId: '../escape' }, options), /invalid_session_id/)
  assert.throws(() => ensureVoiceTaskSession({ ...task, id: randomUUID() }, options), /session_owner_mismatch/)
})
test('delivery survives retries and compaction keeps its receipt', t => {
  const f = fixture(t), task = { id: 'task-1', conversationId: f.id, title: '任务甲', runId: 'run-1' }
  const result = { status: 'completed', summary: '已完成，产物见报告。', model: 'step-5-preview' }
  const first = f.deliver(task, result, 'delivery-1')
  assert.ok(first.messageId); assert.deepEqual(f.deliver(task, result, 'delivery-1'), first)
  let rows = f.origin.getFileEntries()
  assert.equal(rows.filter(r => r.message?.role === 'assistant').length, 1)
  assert.equal(rows.find(r => r.type === 'custom').data.deliveryId, 'delivery-1')
  rows = rows.filter(r => r.message?.role !== 'assistant')
  fs.writeFileSync(f.file, rows.map(JSON.stringify).join(NL) + NL)
  assert.deepEqual(f.deliver(task, result, 'delivery-1'), first)
  assert.equal(f.origin.getFileEntries().filter(r => r.message?.role === 'assistant').length, 0)
})
test('busy and locked origins defer; deleted origins cannot be recreated', t => {
  const f = fixture(t), task = { id: 't', conversationId: f.id, title: '任务' }
  f.active.set(f.id, { sm: f.origin, busy: true })
  assert.throws(() => f.deliver(task, { summary: 'x' }, 'd'), /session_busy/)
  f.active.clear(); f.lock(true)
  assert.throws(() => f.deliver(task, { summary: 'x' }, 'd'), /session_busy/)
  f.lock(false); fs.unlinkSync(f.file)
  assert.deepEqual(f.deliver(task, { summary: 'x' }, 'd'), { code: 'conversation_gone' })
  assert.equal(fs.existsSync(f.file), false)
})
test('idle cached agent is evicted to reload delivered results', t => {
  const f = fixture(t); let disposed = false
  f.active.set(f.id, { sm: f.origin, busy: false, agent: { dispose() { disposed = true } } })
  f.deliver({ id: 't', conversationId: f.id, title: '任务' }, { summary: '结果' }, 'd')
  assert.equal(disposed, true); assert.equal(f.active.has(f.id), false); assert.equal(f.notices(), 1)
})
test('message persisted before receipt is recovered without duplication', t => {
  const f = fixture(t)
  const saved = f.origin.appendMessage({ role: 'assistant', content: 'done', voiceDeliveryId: 'd' })
  const receipt = f.deliver({ id: 't', conversationId: f.id, title: '任务' }, { summary: '结果' }, 'd')
  assert.equal(receipt.messageId, saved.id)
  assert.equal(f.origin.getFileEntries().filter(r => r.message?.role === 'assistant').length, 1)
})

for (const alteration of ['cwd', 'header', 'duplicate-owner', 'hardlink']) test('worker reuse rejects ' + alteration, t => {
  const f = fixture(t), task = { id: randomUUID(), sessionId: randomUUID(), conversationId: f.id, title: '工作者' }
  const options = { sessionsDir: f.sessionsDir, cwd: f.root }, file = path.join(f.sessionsDir, task.sessionId + '.jsonl')
  ensureVoiceTaskSession(task, options)
  const rows = fs.readFileSync(file, 'utf8').trim().split(NL).map(JSON.parse)
  if (alteration === 'cwd') rows[0].cwd = path.dirname(f.root)
  if (alteration === 'header') rows.push({ ...rows[0] })
  if (alteration === 'duplicate-owner') rows.push({ ...rows[2] })
  fs.writeFileSync(file, rows.map(JSON.stringify).join(NL) + NL)
  if (alteration === 'hardlink') fs.linkSync(file, path.join(f.root, 'foreign.jsonl'))
  assert.throws(() => ensureVoiceTaskSession(task, options), /session_owner_mismatch/)
})
