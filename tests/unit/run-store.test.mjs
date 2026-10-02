import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRunStore } from '../../engine/run-store.mjs'

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-store-'))
  let id = 0
  let tick = 0
  const store = createRunStore({
    rootDir,
    idFactory: () => `run-${++id}`,
    now: () => `2026-08-31T10:00:0${tick++}.000Z`,
  })
  return { rootDir, store, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) }
}

test('异步展示列表跳过坏记录且不缓存外部更新，不改变准入的严格读取', async () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const run = store.create({sessionId:'async', clientRequestId:'first', message:'hello'})
    fs.writeFileSync(path.join(rootDir, 'runs', 'broken.json'), '{broken')
    assert.deepEqual(await store.listAsync(), store.list())
    const file = path.join(rootDir, 'runs', `${run.id}.json`)
    fs.writeFileSync(file, JSON.stringify({...run,status:'completed'}))
    assert.equal((await store.listAsync())[0].status, 'completed')
    assert.throws(() => store.readAdmissionSnapshot())
  } finally { cleanup() }
})

test('create 原子写入且同 sessionId+clientRequestId 重试返回同一 run', () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const input = {
      sessionId: 'session-1', clientRequestId: 'request-1', ownerId: 'instance-a',
      message: '这是一条需要持久化的消息', model: 'provider/model',
      files: [{ path: 'D:/safe/image.png', data: 'base64-secret' }],
      authorization: 'Bearer secret', apiKey: 'sk-secret',
    }
    const first = store.create(input)
    const second = store.create({ ...input, message: '重试不应新建' })

    assert.equal(first.id, 'run-1')
    assert.equal(second.id, first.id)
    assert.deepEqual(store.get(first.id), first)
    assert.equal(first.input.messagePreview, input.message)
    assert.deepEqual(first.input.attachments, [{ path: 'D:/safe/image.png' }])

    const raw = fs.readFileSync(path.join(rootDir, 'runs', `${first.id}.json`), 'utf8')
    assert.doesNotMatch(raw, /Bearer secret|sk-secret|base64-secret/)
    assert.deepEqual(fs.readdirSync(path.join(rootDir, 'runs')).filter(name => name.includes('.tmp-')), [])
  } finally { cleanup() }
})

test('active run 可按 session 查询，进入终态后不再占用 session', () => {
  const { store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 'session-1', clientRequestId: 'request-1', ownerId: 'instance-a', message: 'hello' })
    assert.equal(store.findActiveBySession('session-1')?.id, run.id)

    const completed = store.update(run.id, { status: 'completed' })
    assert.equal(completed.status, 'completed')
    assert.equal(store.findActiveBySession('session-1'), null)
  } finally { cleanup() }
})

test('启动恢复把其他 owner 的非终态 run 标记为 interrupted', () => {
  const { store, cleanup } = fixture()
  try {
    const queued = store.create({ sessionId: 's-queued', clientRequestId: 'r-1', ownerId: 'old', message: 'q' })
    const running = store.create({ sessionId: 's-running', clientRequestId: 'r-2', ownerId: 'old', message: 'r' })
    store.update(running.id, { status: 'running' })
    const stopping = store.create({ sessionId: 's-stopping', clientRequestId: 'r-3', ownerId: 'old', message: 's' })
    store.update(stopping.id, { status: 'stopping' })
    const completed = store.create({ sessionId: 's-completed', clientRequestId: 'r-4', ownerId: 'old', message: 'c' })
    store.update(completed.id, { status: 'completed' })
    const current = store.create({ sessionId: 's-current', clientRequestId: 'r-5', ownerId: 'new', message: 'n' })

    const recovered = store.markOrphanedInterrupted('new')

    assert.deepEqual(recovered.map(run => run.id).sort(), [queued.id, running.id, stopping.id].sort())
    assert.equal(store.get(queued.id).status, 'interrupted')
    assert.equal(store.get(running.id).status, 'interrupted')
    assert.equal(store.get(stopping.id).status, 'interrupted')
    assert.equal(store.get(completed.id).status, 'completed')
    assert.equal(store.get(current.id).status, 'queued')
  } finally { cleanup() }
})

test('checkpoint 持久化 phase/step/attempt/updatedAt 并可重载', () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 'session-checkpoint', clientRequestId: 'request-1', ownerId: 'instance-a', message: 'checkpoint' })
    assert.deepEqual(store.getCheckpoint(run.id), {
      phase: 'queued',
      step: 'create',
      attempt: 0,
      updatedAt: run.createdAt,
    })

    const updated = store.saveCheckpoint(run.id, { phase: 'executing', step: 'tool:bash', attempt: 2 })
    assert.deepEqual(updated.checkpoint, {
      phase: 'executing',
      step: 'tool:bash',
      attempt: 2,
      updatedAt: '2026-08-31T10:00:01.000Z',
    })
    assert.deepEqual(store.getCheckpoint(run.id), updated.checkpoint)

    const reloaded = createRunStore({ rootDir, now: () => '2026-08-31T10:00:02.000Z' })
    assert.deepEqual(reloaded.getCheckpoint(run.id), updated.checkpoint)
  } finally { cleanup() }
})

test('checkpoint 持久化 toolPlan 与 historySnapshot 并可重载', () => {
  const { rootDir, store, cleanup } = fixture()
  try {
    const run = store.create({ sessionId: 'session-history', clientRequestId: 'request-1', ownerId: 'instance-a', message: 'snapshot' })
    const toolPlan = [{ id: 'call-1', name: 'read', args: { path: 'README.md' }, status: 'pending' }]
    const historySnapshot = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'snapshot' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }] },
    ]
    const updated = store.saveCheckpoint(run.id, { turn: 1, toolPlan, historySnapshot })
    assert.deepEqual(updated.checkpoint.toolPlan, toolPlan)
    assert.deepEqual(updated.checkpoint.historySnapshot, historySnapshot)

    const reloaded = createRunStore({ rootDir, now: () => '2026-08-31T10:00:03.000Z' })
    assert.deepEqual(reloaded.getCheckpoint(run.id).toolPlan, toolPlan)
    assert.deepEqual(reloaded.getCheckpoint(run.id).historySnapshot, historySnapshot)
  } finally { cleanup() }
})
