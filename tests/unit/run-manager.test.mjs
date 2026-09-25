import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

import { createRunStore } from '../../engine/run-store.mjs'
import { createRunEventLog } from '../../engine/run-event-log.mjs'
import { createRunManager } from '../../engine/run-manager.mjs'
import { createRunEffects, canonicalStepKey } from '../../engine/run-effects.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('completion intake callback runs once and its failure cannot fail the delivered task', async () => {
  let called = 0
  const fx = fixture(async (_req, res) => res.end(), { onRunFinished: run => {
    assert.equal(run.status, 'completed'); called++; throw Error('candidate_disk_full')
  } })
  try {
    const run = fx.manager.create({ sessionId: 'intake', clientRequestId: 'one', message: 'work' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
    assert.equal(called, 1)
    assert.equal(fx.manager.get(run.id).learningIntake.state, 'failed')
  } finally { fx.cleanup() }
})
async function waitFor(check, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const value = check()
    if (value) return value
    await tick()
  }
  throw new Error('condition_not_met')
}

function fixture(executeChat, options = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-manager-'))
  let id = 0
  const store = createRunStore({ rootDir, idFactory: () => `run-${++id}` })
  const eventLog = createRunEventLog({ rootDir })
  const manager = createRunManager({ store, eventLog, executeChat, instanceId: 'instance-a', ...options })
  return { rootDir, store, eventLog, manager, cleanup: () => { eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) } }
}

test('预算暂停只发布一次可恢复终态，继续时保留检查点而不是重跑', async () => {
  const contexts = [];
  const snapshot = { v: 1, turn: 65, messages: [{ role: 'user', content: 'continue' }] };
  const fx = fixture(async (_req, res, body) => {
    contexts.push(body.__runContext);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (contexts.length === 1) {
      res.write(`event: checkpoint\ndata: ${JSON.stringify({ phase: 'tool_results', turn: 65, historySnapshot: snapshot })}\n\n`);
      res.write('event: interrupted\ndata: {"reason":"execution_budget","message":"已暂停，可继续任务"}\n\n');
    }
    res.end();
  });
  try {
    const run = fx.manager.create({ sessionId: 'budget', clientRequestId: 'one', message: 'continue' });
    await waitFor(() => ['completed', 'failed', 'interrupted'].includes(fx.manager.get(run.id)?.status));
    const paused = fx.manager.get(run.id);
    assert.equal(paused.status, 'interrupted'); assert.equal(paused.resumeAvailable, true);
    assert.equal(paused.pauseReason, 'execution_budget'); assert.equal(paused.error, null);
    assert.equal(paused.observability.failureCategory, null);
    assert.equal(fx.manager.readAfter(run.id, 0).filter(e => ['completed', 'failed', 'interrupted'].includes(e.type)).length, 1);
    fx.manager.resume(run.id);
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed');
    assert.deepEqual(contexts[1].checkpoint.historySnapshot, snapshot);
    assert.equal(contexts[1].checkpoint.checkpointKind, 'tool_results');
    assert.equal(fx.manager.get(run.id).pauseReason, null);
  } finally { fx.cleanup(); }
});

test('旧60轮失败记录在 get/list 上恢复继续入口，但没有历史快照不开放', async () => {
  const fx = fixture(async (_req, res, body) => {
    assert.equal(body.__runContext.checkpoint.turn, 60);
    res.end();
  });
  try {
    const run = fx.store.create({ sessionId: 'legacy', clientRequestId: 'one', message: 'continue' });
    const patch = { status: 'failed', resumeAvailable: false, error: '本轮已达到 60 轮工具调用的执行上限，任务尚未完成；已保留工具结果和检查点。' };
    fx.store.update(run.id, patch);
    assert.equal(fx.manager.get(run.id).resumeAvailable, false);
    fx.store.saveCheckpoint(run.id, { turn: 60, checkpointKind: 'tool_results', historySnapshot: { v: 1, turn: 60, messages: [{ role: 'user', content: 'continue' }] } });
    assert.equal(fx.manager.get(run.id).resumeAvailable, true);
    assert.equal(fx.manager.list()[0].resumeAvailable, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.rootDir, 'runs', `${run.id}.json`))).resumeAvailable, false, '兼容读取不篡改历史文件');
    fx.manager.resume(run.id);
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed');
  } finally { fx.cleanup(); }
});

test('聊天记录提交后才发布 session_updated，且事件账本保留顺序', async () => {
  const fx = fixture(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
    const events = fx.manager.readAfter(run.id, 0)
    const sessionUpdated = events.findIndex(event => event.type === 'session_updated')
    const completed = events.findIndex(event => event.type === 'completed')
    assert.ok(sessionUpdated >= 0)
    assert.ok(sessionUpdated < completed)
  } finally { fx.cleanup() }
})

test('可恢复的工具截断失败保留继续任务入口', async () => {
  const fx = fixture(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('event: checkpoint\ndata: {"phase":"tool_results","turn":2,"historySnapshot":{"v":1,"turn":2,"messages":[{"role":"user","content":"生成 PPT"}]}}\n\n')
    res.write('event: error\ndata: {"message":"工具调用被截断（多半是输出超长）"}\n\n')
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-recover', clientRequestId: 'request-1', message: '生成 PPT' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'failed')
    assert.equal(fx.manager.get(run.id).resumeAvailable, true)
  } finally { fx.cleanup() }
})

test('create 立即返回，后台执行完成且全部事件可重放', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fx = fixture(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('event: delta\ndata: {"text":"A"}\n\n')
    await gate
    res.write('event: done\ndata: {"sessionId":"session-1"}\n\n')
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'hello' })
    assert.equal(run.status, 'queued')
    await waitFor(() => fx.manager.get(run.id)?.status === 'running')
    release()
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')

    const events = fx.manager.readAfter(run.id, 0)
    assert.ok(events.some(event => event.type === 'delta' && event.data.text === 'A'))
    assert.ok(events.some(event => event.type === 'done'))
    assert.equal(events.at(-1).type, 'completed')
  } finally { fx.cleanup() }
})


test('取消浏览器订阅不会关闭后台请求或停止 run', async () => {
  let closeCount = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fx = fixture(async (req, res) => {
    req.on('close', () => { closeCount++ })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    await gate
    res.write('event: done\ndata: {}\n\n')
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'running')
    const unsubscribe = fx.manager.subscribe(run.id, () => {})
    unsubscribe()
    await tick()
    assert.equal(closeCount, 0)
    assert.equal(fx.manager.get(run.id).status, 'running')
    release()
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
  } finally { fx.cleanup() }
})

test('stop 幂等且只有显式 stop 会关闭一次后台请求', async () => {
  let closeCount = 0
  const fx = fixture(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    await once(req, 'close')
    closeCount++
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'running')
    fx.manager.stop(run.id)
    fx.manager.stop(run.id)
    await waitFor(() => fx.manager.get(run.id)?.status === 'stopped')
    assert.equal(closeCount, 1)
    assert.equal(fx.manager.stop(run.id).status, 'stopped')
  } finally { fx.cleanup() }
})

test('同 session 的第二个 active run 返回 session_busy', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const fx = fixture(async (_req, res) => { res.writeHead(200); await gate; res.end() })
  try {
    const first = fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'first' })
    assert.throws(
      () => fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-2', message: 'second' }),
      error => error.code === 'session_busy' && error.activeRunId === first.id,
    )
    assert.equal(fx.manager.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'retry' }).id, first.id)
    release()
    await waitFor(() => fx.manager.get(first.id)?.status === 'completed')
  } finally { fx.cleanup() }
})

test('后台执行结束时持久化可序列化运行观测指标', async () => {
  const fx = fixture(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('event: tool\ndata: {"name":"read","id":"tool-1"}\n\n')
    res.write('event: tool_end\ndata: {"name":"read","id":"tool-1","isError":false}\n\n')
    res.write('event: done\ndata: {"model":{"provider":"provider-a","id":"model-a"}}\n\n')
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-metrics', clientRequestId: 'request-1', message: 'metrics' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
    const current = fx.manager.get(run.id)
    assert.equal(typeof current.observability.durationMs, 'number')
    assert.equal(current.observability.eventCounts.tool, 1)
    assert.equal(current.observability.eventCounts.tool_end, 1)
    assert.deepEqual(current.observability.lastModel, { provider: 'provider-a', id: 'model-a' })
    assert.deepEqual(current.observability.lastTool, { id: 'tool-1', name: 'read', status: 'completed' })
    assert.equal(current.observability.failureCategory, null)
    assert.doesNotThrow(() => JSON.stringify(current.observability))
  } finally { fx.cleanup() }
})

test('recover 标记 resumeAvailable，resume(runId) 发布事件并重新执行', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-resume-'))
  let id = 0
  const store = createRunStore({ rootDir, idFactory: () => `run-${++id}` })
  const eventLog = createRunEventLog({ rootDir })
  const calls = []
  const executeChat = async (_req, res, body) => {
    calls.push(body)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('event: done\ndata: {"sessionId":"session-1"}\n\n')
    res.end()
  }
  const run = store.create({ sessionId: 'session-1', clientRequestId: 'request-1', message: 'resume me', params: { temperature: 0.2 }, ownerId: 'instance-old' })
  store.update(run.id, { status: 'running', startedAt: new Date().toISOString() })

  const newManager = createRunManager({ store, eventLog, executeChat, instanceId: 'instance-new' })
  const recovered = newManager.recover()
  assert.equal(recovered.length, 1)
  assert.equal(newManager.get(run.id).status, 'interrupted')
  assert.equal(newManager.get(run.id).resumeAvailable, true)

  const resumed = newManager.resume(run.id)
  assert.equal(resumed.status, 'queued')
  assert.equal(resumed.resumeAvailable, false)
  assert.equal(resumed.checkpoint.phase, 'resuming')
  assert.equal(resumed.checkpoint.attempt, 1)
  assert.ok(newManager.readAfter(run.id, 0).some(event => event.type === 'resumed'))

  await waitFor(() => newManager.get(run.id)?.status === 'completed')
  assert.equal(calls.at(-1).message, 'resume me')
  assert.deepEqual(calls.at(-1).params, { temperature: 0.2 })
  assert.equal(newManager.get(run.id).resumeAvailable, false)
  assert.equal(newManager.resume(run.id).status, 'completed')
  eventLog.close()
  fs.rmSync(rootDir, { recursive: true, force: true })
})

test('run manager 给执行器注入内部 runContext，恢复时递增 attempt', async () => {
  const contexts = []
  const effects = { marker: true }
  const fx = fixture(async (_req, res, body) => {
    contexts.push(body.__runContext)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end()
  }, { effects })
  try {
    const run = fx.manager.create({ sessionId: 'session-context', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
    assert.equal(contexts[0].runId, run.id)
    assert.equal(contexts[0].attempt, 0)
    assert.equal(contexts[0].effects, effects)

    fx.store.update(run.id, { status: 'interrupted', resumeAvailable: true })
    fx.manager.resume(run.id)
    await waitFor(() => contexts.length === 2)
    assert.equal(contexts[1].runId, run.id)
    assert.equal(contexts[1].attempt, 1)
    assert.equal(contexts[1].resume, true)
  } finally { fx.cleanup() }
})

test('runContext 可把工具计划与模型历史快照写回持久化 checkpoint', async () => {
  const contexts = []
  const fx = fixture(async (_req, res, body) => {
    contexts.push(body.__runContext)
    body.__runContext.saveCheckpoint({
      phase: 'executing',
      step: 'tool:read',
      turn: 1,
      toolPlan: [{ id: 'call-1', name: 'read', args: { path: 'README.md' }, status: 'pending' }],
      historySnapshot: [{ role: 'user', content: 'hello' }],
    })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end()
  })
  try {
    const run = fx.manager.create({ sessionId: 'session-checkpoint-context', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => fx.manager.get(run.id)?.status === 'completed')
    const checkpoint = fx.manager.get(run.id).checkpoint
    assert.equal(checkpoint.turn, 1)
    assert.deepEqual(checkpoint.toolPlan, [{ id: 'call-1', name: 'read', args: { path: 'README.md' }, status: 'pending' }])
    assert.deepEqual(checkpoint.historySnapshot, [{ role: 'user', content: 'hello' }])
  } finally { fx.cleanup() }
})

test('tool 事件会把 effects ledger 状态同步进 checkpoint', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-effects-manager-'))
  const store = createRunStore({ rootDir, idFactory: () => 'run-effects' })
  const eventLog = createRunEventLog({ rootDir })
  const effects = createRunEffects({ rootDir })
  const manager = createRunManager({
    store, eventLog, effects, instanceId: 'instance-a',
    executeChat: async (_req, res) => {
      const key = canonicalStepKey('write', { path: 'a.txt', content: 'x' }, { turn: 1, index: 0 })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: tool\ndata: ${JSON.stringify({ name: 'write', effectKey: key, argsHash: 'hash', turn: 1, ordinal: 0 })}\n\n`)
      res.write(`event: tool_end\ndata: ${JSON.stringify({ name: 'write', effectKey: key, isError: false, output: 'ok' })}\n\n`)
      res.end()
    },
  })
  try {
    const run = manager.create({ sessionId: 'session-effects', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => manager.get(run.id)?.status === 'completed')
    const current = manager.get(run.id)
    assert.deepEqual(current.checkpoint.completedSteps, [canonicalStepKey('write', { path: 'a.txt', content: 'x' }, { turn: 1, index: 0 })])
    assert.deepEqual(effects.get(run.id, current.checkpoint.completedSteps[0]).state, 'completed')
  } finally { eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) }
})


test('checkpoint 事件持久化工具计划与历史快照，恢复上下文保留快照', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-checkpoint-snapshot-'))
  const store = createRunStore({ rootDir, idFactory: () => 'run-snapshot' })
  const eventLog = createRunEventLog({ rootDir })
  const snapshot = { v: 1, messages: [{ role: 'system', content: 'system' }, { role: 'tool', content: 'done' }] }
  const toolPlan = [{ id: 'provider-id', name: 'bash', argsHash: 'hash', ordinal: 0 }]
  const contexts = []
  const manager = createRunManager({
    store, eventLog, instanceId: 'instance-a',
    executeChat: async (_req, res, body) => {
      contexts.push(body.__runContext)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: checkpoint\ndata: ${JSON.stringify({ phase: 'tool_plan', turn: 3, toolPlan, historySnapshot: snapshot })}\n\n`)
      res.end()
    },
  })
  try {
    const run = manager.create({ sessionId: 'session-snapshot', clientRequestId: 'request-1', message: 'hello' })
    await waitFor(() => manager.get(run.id)?.status === 'completed')
    assert.equal(manager.get(run.id).checkpoint.turn, 3)
    assert.deepEqual(manager.get(run.id).checkpoint.toolPlan, toolPlan)
    assert.deepEqual(manager.get(run.id).checkpoint.historySnapshot, snapshot)

    store.update(run.id, { status: 'interrupted', resumeAvailable: true })
    manager.resume(run.id)
    await waitFor(() => contexts.length === 2)
    assert.deepEqual(contexts[1].checkpoint.historySnapshot, snapshot)
    assert.deepEqual(contexts[1].checkpoint.toolPlan, toolPlan)
  } finally { eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) }
})

test('真实 checkpoint writer 事件不会把 canonical checkpointKind 覆盖成 transport phase', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piweb-run-checkpoint-kind-'))
  const store = createRunStore({ rootDir, idFactory: () => 'run-kind' })
  const eventLog = createRunEventLog({ rootDir })
  const toolPlan = [{ id: 'call-1', name: 'read', args: { path: 'README.md' }, ordinal: 0, status: 'pending' }]
  const contexts = []
  const manager = createRunManager({
    store, eventLog, instanceId: 'instance-a',
    executeChat: async (_req, res, body) => {
      contexts.push(body.__runContext)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (contexts.length === 1) {
        res.write(`event: checkpoint\ndata: ${JSON.stringify({ phase: 'executing', step: 'tool-plan', checkpointKind: 'tool_plan', turn: 2, toolPlan })}\n\n`)
      } else {
        res.write('event: done\ndata: {}\n\n')
      }
      res.end()
    },
  })
  try {
    const run = manager.create({ sessionId: 'session-kind', clientRequestId: 'request-1', message: 'resume plan' })
    await waitFor(() => manager.get(run.id)?.status === 'completed')
    assert.equal(manager.get(run.id).checkpoint.checkpointKind, 'tool_plan')
    assert.deepEqual(manager.get(run.id).checkpoint.toolPlan, toolPlan)

    store.update(run.id, { status: 'interrupted', resumeAvailable: true })
    manager.resume(run.id)
    await waitFor(() => contexts.length === 2)
    assert.equal(contexts[1].resume, true)
    assert.equal(contexts[1].checkpoint.checkpointKind, 'tool_plan')
    assert.deepEqual(contexts[1].checkpoint.toolPlan, toolPlan)
  } finally { eventLog.close(); fs.rmSync(rootDir, { recursive: true, force: true }) }
})
