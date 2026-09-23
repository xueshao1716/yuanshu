import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRunSnapshot, phaseFromEvent, summarizeRun } from '../../engine/run-observability.mjs'

test('events map to stable user-facing phases', () => {
  assert.equal(phaseFromEvent('run_started'), 'executing')
  assert.equal(phaseFromEvent('tool_started'), 'executing')
  assert.equal(phaseFromEvent('session_updated'), 'delivering')
  assert.equal(phaseFromEvent('completed'), 'completed')
  assert.equal(phaseFromEvent('failed'), 'failed')
})

test('summarizeRun includes current phase and safe error preview', () => {
  const summary = summarizeRun(
    { id: 'r1', status: 'failed', sessionId: 's1', input: { messagePreview: '做个总结' }, error: '模型失败' },
    [{ type: 'run_started' }, { type: 'tool_started', data: { name: 'read' } }, { type: 'failed', data: { message: '模型失败' } }],
  )

  assert.deepEqual(summary, {
    id: 'r1', sessionId: 's1', status: 'failed', phase: 'failed',
    messagePreview: '做个总结', toolCount: 1, memoryCount: 0, memoryPreview: null, error: '模型失败', resumeAvailable: false,
    durationMs: null,
    eventCounts: { failed: 1, run_started: 1, tool_started: 1 },
    engine: null,
    requestedModel: null,
    textModel: null,
    mediaModels: [],
    lastModel: null,
    lastTool: { name: 'read', status: 'started' },
    failureCategory: 'model',
  })
})

test('summarizeRun exposes a recoverable failed run', () => {
  const summary = summarizeRun(
    { id: 'r-recover', status: 'failed', resumeAvailable: true, sessionId: 's-recover', input: { messagePreview: '生成 PPT' }, error: '工具调用被截断' },
    [{ type: 'error', data: { message: '工具调用被截断' } }, { type: 'failed', data: { message: '工具调用被截断' } }],
  )
  assert.equal(summary.resumeAvailable, true)
})

test('summarizeRun counts memory writes and keeps a safe context preview', () => {
  const summary = summarizeRun(
    { id: 'r2', status: 'completed', sessionId: 's2', input: { messagePreview: '继续' } },
    [
      { type: 'memory_written', data: { count: 2, preview: '用户偏好简洁回答' } },
      { type: 'completed' },
    ],
  )
  assert.equal(summary.memoryCount, 2)
  assert.equal(summary.memoryPreview, '用户偏好简洁回答')
})

test('buildRunSnapshot returns empty overview without active runs', () => {
  assert.deepEqual(buildRunSnapshot([], new Map()), {
    active: [], recent: [], health: { status: 'idle', activeCount: 0, failedCount: 0 },
  })
})

test('summarizeRun exposes serializable runtime metrics from the event ledger', () => {
  const summary = summarizeRun(
    {
      id: 'r3',
      status: 'failed',
      sessionId: 's3',
      startedAt: '2026-09-09T10:00:00.000Z',
      failedAt: '2026-09-09T10:00:04.250Z',
      input: { messagePreview: '执行任务' },
    },
    [
      { type: 'run_started', ts: '2026-09-09T10:00:00.000Z' },
      { type: 'tool', ts: '2026-09-09T10:00:01.000Z', data: { name: 'read', id: 'tool-1' } },
      { type: 'tool_end', ts: '2026-09-09T10:00:02.000Z', data: { name: 'read', id: 'tool-1', isError: false } },
      { type: 'done', ts: '2026-09-09T10:00:03.000Z', data: { model: { provider: 'p', id: 'm' } } },
      { type: 'error', ts: '2026-09-09T10:00:04.000Z', data: { message: '模型请求超时' } },
    ],
  )

  assert.equal(summary.durationMs, 4250)
  assert.deepEqual(summary.eventCounts, { done: 1, error: 1, run_started: 1, tool: 1, tool_end: 1 })
  assert.deepEqual(summary.lastModel, { provider: 'p', id: 'm' })
  assert.deepEqual(summary.lastTool, { id: 'tool-1', name: 'read', status: 'completed' })
  assert.equal(summary.failureCategory, 'timeout')
})

test('separates execution engine, text model, and media models', async () => {
  const { deriveRunObservability } = await import('../../engine/run-observability.mjs')
  const out = deriveRunObservability(
    { id: 'r-media', status: 'completed', input: { model: { provider: 'pi-provider', id: 'text-default' } } },
    [
      { type: 'engine_selected', data: { engine: 'yuanshu' } },
      { type: 'model_selected', data: { model: { provider: 'pi-provider', id: 'text-live' } } },
      { type: 'media', data: { type: 'image', url: '/api/media/1', model: 'agnes/agnes-image-2.5-flash' } },
      { type: 'done', data: { model: { provider: 'pi-provider', id: 'text-live' } } },
    ],
  )
  assert.equal(out.engine, 'yuanshu')
  assert.deepEqual(out.textModel, { provider: 'pi-provider', id: 'text-live' })
  assert.deepEqual(out.mediaModels, [{ provider: 'agnes', id: 'agnes-image-2.5-flash' }])
  assert.deepEqual(out.lastModel, { provider: 'pi-provider', id: 'text-live' })
})
