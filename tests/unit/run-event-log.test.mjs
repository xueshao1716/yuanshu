import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createRunEventLog } from '../../engine/run-event-log.mjs'

function fixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-events-'))
  let tick = 0
  const log = createRunEventLog({ rootDir, now: () => `2026-08-31T10:00:0${tick++}.000Z` })
  return { rootDir, log, cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }) }
}

test('历史回放不再投递只读工具误抓的裸媒体，游标和原账本不变', () => {
  const { rootDir, log, cleanup } = fixture()
  try {
    const emit = (type, data) => log.append({ runId: 'legacy', sessionId: 's', type, data })
    emit('tool_end', { id: 'r', name: 'read', output: '长协议截断，路径不在这2000字内' })
    emit('media', { type: 'video', url: '/api/ws/file?path=生成物%2Fold.mp4' })
    emit('tool', { id: 'b', name: 'bash', args: { command: 'tail -20 工程/经验库/experience.md' } })
    emit('tool_end', { id: 'b', name: 'bash', output: '生成物/old.png' })
    emit('media', { type: 'image', url: '/api/ws/file?path=' + encodeURIComponent('生成物/old.png') })
    emit('tool_end', { id: 'g', name: 'generate_image', output: '生成物/new.png' })
    emit('media', { type: 'image', url: '/api/ws/file?path=生成物%2Fnew.png' })
    emit('tool_end', { id: 'b2', name: 'bash', output: 'other' })
    emit('media', { type: 'image', url: '/new.png', source: 'tool', toolCallId: 'b2' })
    emit('media', { type: 'image', url: '/side.png', model: 'image-model' })
    emit('done', {})
    const file = path.join(rootDir, 'events', 'legacy.jsonl'), before = fs.readFileSync(file, 'utf8')
    assert.deepEqual(log.readAfter('legacy', 1).map(e => e.seq), [3, 4, 6, 7, 8, 9, 10, 11])
    assert.equal(log.getLastSeq('legacy'), 11)
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  } finally { log.close(); cleanup() }
})

test('来源不明的旧媒体、主动下载工具交付和异步旁路结果不误删', () => {
  const { log, cleanup } = fixture()
  try {
    const emit = (type, data) => log.append({ runId: 'legacy', sessionId: 's', type, data })
    emit('media', { type: 'image', url: '/unknown.png' })
    emit('tool', { id: 'd', name: 'bash', args: { command: 'curl https://example.com/i.png -o 生成物/new.png' } })
    emit('tool_end', { id: 'd', name: 'bash', output: '生成物/new.png' })
    emit('media', { type: 'image', url: '/api/ws/file?path=' + encodeURIComponent('生成物/new.png') })
    assert.equal(log.readAfter('legacy').length, 4)
  } finally { log.close(); cleanup() }
})

test('append 为单个 run 生成连续 seq，readAfter 精确重放游标之后事件', () => {
  const { log, cleanup } = fixture()
  try {
    const first = log.append({ runId: 'run-1', sessionId: 'session-1', type: 'delta', data: { text: 'A' } })
    const second = log.append({ runId: 'run-1', sessionId: 'session-1', type: 'delta', data: { text: 'B' } })
    const other = log.append({ runId: 'run-2', sessionId: 'session-2', type: 'done', data: {} })

    assert.equal(first.seq, 1)
    assert.equal(second.seq, 2)
    assert.equal(other.seq, 1)
    assert.deepEqual(log.readAfter('run-1', 1), [second])
    assert.equal(log.getLastSeq('run-1'), 2)
  } finally { log.close(); cleanup() }
})

test('后台读取和生成混合命令的历史媒体必须保留', () => {
  const { log, cleanup } = fixture()
  try {
    const emit = (type, data) => log.append({ runId: 'mixed', sessionId: 's', type, data })
    emit('tool', { id: 'b', name: 'bash', args: { command: 'cat reference.md & node draw.mjs' } })
    emit('tool_end', { id: 'b', name: 'bash', output: '生成物/new.png' })
    emit('media', { type: 'image', url: '/api/ws/file?path=' + encodeURIComponent('生成物/new.png') })
    assert.deepEqual(log.readAfter('mixed').map(e => e.seq), [1, 2, 3])
  } finally { log.close(); cleanup() }
})

test('读取忽略 JSONL 尾部半行，后续 append 仍产生合法新事件', () => {
  const { rootDir, log, cleanup } = fixture()
  try {
    log.append({ runId: 'run-1', sessionId: 'session-1', type: 'delta', data: { text: 'A' } })
    const file = path.join(rootDir, 'events', 'run-1.jsonl')
    fs.appendFileSync(file, '{"v":1,"broken"', 'utf8')

    assert.equal(log.getLastSeq('run-1'), 1)
    const second = log.append({ runId: 'run-1', sessionId: 'session-1', type: 'done', data: {} })
    assert.equal(second.seq, 2)
    assert.deepEqual(log.readAfter('run-1', 0).map(event => event.seq), [1, 2])
  } finally { log.close(); cleanup() }
})

test('尾行 JSON 完整但缺少换行时 append 保留该事件', () => {
  const { rootDir, log, cleanup } = fixture()
  try {
    const file = path.join(rootDir, 'events', 'run-1.jsonl')
    const first = { v: 1, runId: 'run-1', sessionId: 'session-1', seq: 1, type: 'delta', ts: '2026-08-31T10:00:00.000Z', data: { text: 'A' } }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(first), 'utf8')

    const second = log.append({ runId: 'run-1', sessionId: 'session-1', type: 'done', data: {} })

    assert.equal(second.seq, 2)
    assert.deepEqual(log.readAfter('run-1', 0).map(event => event.seq), [1, 2])
  } finally { log.close(); cleanup() }
})

test('事件账本脱敏凭据并省略大段图片 base64', () => {
  const { rootDir, log, cleanup } = fixture()
  try {
    let liveEvent
    log.subscribe('run-1', event => { liveEvent = event })
    const event = log.append({
      runId: 'run-1', sessionId: 'session-1', type: 'image',
      data: { data: 'A'.repeat(20_000), apiKey: 'sk-secret-value', authorization: 'Bearer secret-token' },
    })
    const raw = fs.readFileSync(path.join(rootDir, 'events', 'run-1.jsonl'), 'utf8')

    assert.doesNotMatch(raw, /sk-secret-value|Bearer secret-token/)
    assert.equal(event.data.data, undefined)
    assert.equal(event.data.omitted, true)
    assert.equal(liveEvent.data.data.length, 20_000)
    assert.equal(liveEvent.data.apiKey, '[REDACTED]')
    assert.equal(log.readAfter('run-1', 0)[0].data.data, undefined)
  } finally { log.close(); cleanup() }
})

test('单个 subscriber 抛错不影响事件落盘和其他 subscriber', () => {
  const { log, cleanup } = fixture()
  try {
    const observed = []
    log.subscribe('run-1', () => { throw new Error('observer failed') })
    log.subscribe('run-1', event => observed.push(event.seq))

    assert.doesNotThrow(() => log.append({ runId: 'run-1', sessionId: 'session-1', type: 'delta', data: { text: 'A' } }))
    assert.deepEqual(observed, [1])
    assert.equal(log.getLastSeq('run-1'), 1)
  } finally { log.close(); cleanup() }
})

test('subscriber 只在事件成功落盘后收到通知，取消订阅后不再收到', () => {
  const { rootDir, log, cleanup } = fixture()
  try {
    const observed = []
    const unsubscribe = log.subscribe('run-1', event => {
      const file = path.join(rootDir, 'events', 'run-1.jsonl')
      const persisted = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).some(line => {
        try { return JSON.parse(line).seq === event.seq } catch { return false }
      })
      observed.push({ event, persisted })
    })

    const first = log.append({ runId: 'run-1', sessionId: 'session-1', type: 'delta', data: { text: 'A' } })
    unsubscribe()
    log.append({ runId: 'run-1', sessionId: 'session-1', type: 'done', data: {} })

    assert.deepEqual(observed, [{ event: first, persisted: true }])
  } finally { log.close(); cleanup() }
})
