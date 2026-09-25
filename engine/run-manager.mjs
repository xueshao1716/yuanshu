import { EventEmitter } from 'node:events'
import { deriveRunObservability } from './run-observability.mjs'
import { createBackgroundRecovery, newRecoveryPolicy, RUN_SLICE_MS } from './run-recovery.mjs'

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted'])

function createSseParser(onEvent) {
  let buffer = ''
  const consume = block => {
    if (!block || block.startsWith(':')) return
    let type = 'message'
    const dataLines = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    const raw = dataLines.join('\n')
    let data = raw
    try { data = JSON.parse(raw) } catch {}
    onEvent(type, data)
  }
  return {
    push(chunk) {
      buffer += String(chunk)
      let boundary
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const match = buffer.slice(boundary).match(/^(?:\r?\n){2}/)?.[0] || '\n\n'
        consume(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + match.length)
      }
    },
    flush() {
      consume(buffer.trim())
      buffer = ''
    },
  }
}

function createExecutionIo({ headers = {}, socket = {}, onEvent }) {
  const req = new EventEmitter()
  req.headers = { ...headers }
  req.socket = { remoteAddress: '127.0.0.1', ...socket }
  req.destroyed = false

  const res = new EventEmitter()
  const parser = createSseParser(onEvent)
  res.statusCode = 200
  res.headers = {}
  res.writableEnded = false
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value }
  res.writeHead = (code, responseHeaders = {}) => {
    res.statusCode = code
    for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value)
    return res
  }
  res.write = chunk => {
    if (res.writableEnded) return false
    parser.push(chunk)
    return true
  }
  res.end = chunk => {
    if (res.writableEnded) return res
    if (chunk != null) parser.push(chunk)
    parser.flush()
    res.writableEnded = true
    res.emit('finish')
    return res
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    req.destroyed = true
    req.emit('close')
  }
  return { req, res, close }
}

export function createRunManager({ store, eventLog, executeChat, instanceId, onSessionUpdated = null, onRunFinished = null, effects = null, workspaceScope = () => null, scheduleRecovery }) {
  const executions = new Map()
  let recovery

  const checkpointForEvent = (type, data = {}) => {
    const name = data?.name || data?.toolName || ''
    if (type === 'run_started') return { phase: 'executing', step: 'chat' }
    if (type === 'reasoning') return { phase: 'thinking', step: 'reasoning' }
    if (type === 'tool' || type === 'tool_start' || type === 'tool_started') return { phase: 'executing', step: name ? `tool:${name}` : 'tool' }
    if (type === 'tool_end' || type === 'tool_finished') return { phase: 'executing', step: name ? `tool:${name}:done` : 'tool:done' }
    if (type === 'checkpoint') {
      // The SSE payload emitted by the checkpoint writer has a transport
      // phase (`executing`) as well as the canonical logical kind
      // (`tool_plan`, `model_request`, ...). Persist the latter so recovery
      // can select the correct replay path after the event has crossed the
      // manager boundary.
      const checkpointKind = typeof data.checkpointKind === 'string' && data.checkpointKind
        ? data.checkpointKind
        : data.phase || 'checkpoint'
      const logicalKind = checkpointKind === 'tool_results' || checkpointKind === 'model_response' || checkpointKind === 'model_request' || checkpointKind === 'tool_plan'
        ? checkpointKind
        : null
      return {
      phase: 'executing',
      step: logicalKind === 'tool_results' ? 'tool-results' : logicalKind === 'model_response' ? 'model-response' : logicalKind === 'model_request' ? 'model-request' : 'tool-plan',
      checkpointKind,
      ...(Number.isInteger(data.turn) ? { turn: data.turn } : {}),
      ...(Array.isArray(data.toolPlan) ? { toolPlan: data.toolPlan } : {}),
      ...(data.historySnapshot && typeof data.historySnapshot === 'object' ? { historySnapshot: data.historySnapshot } : data.v === 1 && Array.isArray(data.messages) ? { historySnapshot: { v: 1, turn: data.turn, messages: data.messages, digest: data.digest } } : {}),
      ...(data.historyDigest || data.digest ? { historyDigest: String(data.historyDigest || data.digest) } : {}),
      ...(Number.isInteger(data.historyCount) ? { historyCount: data.historyCount } : Array.isArray(data.messages) ? { historyCount: data.messages.length } : {}),
      }
    }
    if (type === 'handoff') return { phase: 'executing', step: 'handoff' }
    if (type === 'memory_written') return { phase: 'remembering', step: 'memory' }
    if (type === 'artifact_created') return { phase: 'delivering', step: 'artifact' }
    if (type === 'session_updated') return { phase: 'delivering', step: 'session:commit' }
    if (type === 'error' || type === 'failed') return { phase: 'failed', step: 'error' }
    if (type === 'completed' || type === 'done') return { phase: 'completed', step: 'done' }
    if (type === 'stopped') return { phase: 'stopped', step: 'stopped' }
    if (type === 'interrupted') return { phase: 'interrupted', step: 'recover' }
    return null
  }

  const append = (run, type, data = {}) => {
    // Conservative approval barrier: a restarted process cannot settle the old promise.
    if (type === 'confirm') store.update(run.id, { approvalRequired: true })
    const event = eventLog.append({
      runId: run.id,
      sessionId: run.sessionId,
      type,
      data,
    })
    if (effects && data?.effectKey) {
      try {
        if (type === 'tool' || type === 'tool_start' || type === 'tool_started') {
          effects.begin(run.id, data.effectKey, {
            toolName: data.name || data.toolName,
            argsHash: data.argsHash,
            ordinal: data.ordinal,
            turn: data.turn,
            attempt: run.checkpoint?.attempt,
          })
        } else if (type === 'tool_end' || type === 'tool_finished') {
          if (data.uncertain) effects.markUncertain(run.id, data.effectKey, 'tool_reported_uncertain')
          else effects.complete(run.id, data.effectKey, { text: data.output || '', isError: data.isError === true })
        }
      } catch {}
    }
    const patch = checkpointForEvent(type, data)
    if (patch && typeof store.saveCheckpoint === 'function') {
      try {
        const steps = typeof effects?.list === 'function' ? effects.list(run.id) : []
        store.saveCheckpoint(run.id, {
          ...patch,
          lastEventSeq: event.seq,
          completedSteps: steps.filter(step => step.state === 'completed').map(step => step.key),
          uncertainSteps: steps.filter(step => step.state === 'uncertain').map(step => step.key),
          pendingSteps: steps.filter(step => step.state === 'started').map(step => step.key),
        })
      } catch {}
    }
    return event
  }

  const makeControl = (run, body, context = {}) => {
    const now = Date.now()
    // Only scheduler-owned continuations inherit the automatic window. A manual
    // retry may follow a network failure that left the old policy marked running.
    const executionBudgetMs = context.automaticRecovery === true && run.backgroundRecovery?.state === 'running'
      ? Math.max(1, Math.min(RUN_SLICE_MS, Date.parse(run.backgroundRecovery.deadlineAt) - now)) : RUN_SLICE_MS
    const runContext = {
      executionBudgetMs,
      executionDeadlineAt: now + executionBudgetMs,
      runId: run.id,
      attempt: Number.isInteger(run.checkpoint?.attempt) ? run.checkpoint.attempt : 0,
      resume: body?.resume === true,
      checkpoint: run.checkpoint || null,
      effects,
      completedSteps: typeof effects?.list === 'function' ? effects.list(run.id).filter(step => step.state === 'completed').map(step => step.key) : [],
      uncertainSteps: typeof effects?.list === 'function' ? effects.list(run.id).filter(step => step.state === 'uncertain').map(step => step.key) : [],
      saveCheckpoint(patch = {}) {
        const updated = store.saveCheckpoint(run.id, patch)
        runContext.checkpoint = updated.checkpoint
        return updated.checkpoint
      },
    }
    return {
      runId: run.id,
      body: {
        ...body,
        // Internal-only context: run-api strips persisted request details and
        // this object never crosses the public JSON boundary.
        __runContext: runContext,
      },
      context: { headers: context.headers || {}, socket: context.socket || {} },
      close: null,
      stopRequested: false,
    }
  }

  const enqueue = (run, body, context = {}) => {
    if (TERMINAL.has(run.status) || executions.has(run.id)) return run
    const control = makeControl(run, body, context)
    executions.set(run.id, control)
    queueMicrotask(() => start(control))
    return run
  }

  const finish = (runId, status, data = {}) => {
    const current = store.get(runId)
    if (!current || TERMINAL.has(current.status)) return current
    if (status === 'interrupted' && recovery.trySchedule(current, data.reason)) return store.get(runId)
    const failureText = String(data.message || data.error || current.error || '')
    const resumableFailure = status === 'failed'
      && !!current.checkpoint?.historySnapshot
      && /截断|超长|timeout|timed out|超时|fetch failed|连接|网络/i.test(failureText)
    const updated = store.update(runId, {
      status,
      ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      ...(status === 'failed' ? { failedAt: new Date().toISOString(), error: data.message || 'run_failed' } : {}),
      ...(status === 'stopped' ? { stoppedAt: new Date().toISOString() } : {}),
      ...(status === 'interrupted' ? { interruptedAt: new Date().toISOString(), error: null,
        pauseReason: data.reason || 'interrupted', pauseMessage: data.message || null,
        resumeAvailable: !!current.checkpoint?.historySnapshot } : {}),
      ...(status === 'failed' ? { resumeAvailable: current.resumeAvailable === true || resumableFailure } : {}),
      ...(['failed', 'stopped'].includes(status) && (current.checkpoint?.team?.launchId || current.checkpoint?.team?.general) ? { resumeAvailable: true } : {}),
    })
    append(updated, status, data)
    const observability = deriveRunObservability(updated, eventLog.readAfter(runId, 0))
    const finished = store.update(runId, { observability })
    try { onRunFinished?.(finished) }
    catch { store.update(runId, { learningIntake: { state: 'failed', reason: 'candidate_write_failed' } }) }
    return store.get(runId)
  }

  const start = async control => {
    const initial = store.get(control.runId)
    if (!initial || TERMINAL.has(initial.status)) return
    if (control.stopRequested) {
      finish(initial.id, 'stopped', { reason: 'stopped_before_start' })
      executions.delete(initial.id)
      return
    }

    const running = store.update(initial.id, { status: 'running', startedAt: new Date().toISOString() })
    append(running, 'run_started', { status: 'running' })
    let sawError = null
    let sawPause = null
    const io = createExecutionIo({
      headers: control.context.headers,
      socket: control.context.socket,
      onEvent(type, data) {
        // Publish the terminal event only after persistence/cleanup completes.
        if (type === 'interrupted') { sawPause = data; return }
        const current = store.get(running.id)
        append(current || running, type, data)
        if (type === 'error') sawError = data
      },
    })
    control.close = io.close

    if (control.stopRequested) io.close()
    try {
      await executeChat(io.req, io.res, control.body)
      if (!io.res.writableEnded) io.res.end()
      const current = store.get(running.id)
      if (control.stopRequested || current?.status === 'stopping') {
        finish(running.id, 'stopped', { reason: 'user_stop' })
      } else if (sawError || io.res.statusCode >= 400) {
        const message = sawError?.message || sawError?.error || `HTTP ${io.res.statusCode}`
        finish(running.id, 'failed', { message })
      } else if (sawPause) {
        try { onSessionUpdated?.({ run: current || running }) } catch {}
        append(current || running, 'session_updated', { sessionId: running.sessionId })
        finish(running.id, 'interrupted', sawPause)
      } else {
        // executeChat 返回时，聊天 JSONL 已经完成本轮写入；先通知前端刷新历史，再发布 Run 终态。
        // 这样会话记录不会等到下一次手动刷新或列表缓存自然过期才出现。
        const committed = store.get(running.id)
        try { onSessionUpdated?.({ run: committed || running }) } catch {}
        append(committed || running, 'session_updated', { sessionId: running.sessionId })
        finish(running.id, 'completed', {})
      }
    } catch (error) {
      const current = store.get(running.id)
      if (control.stopRequested || current?.status === 'stopping') {
        finish(running.id, 'stopped', { reason: 'user_stop' })
      } else {
        finish(running.id, 'failed', { message: String(error?.message || error) })
      }
    } finally {
      executions.delete(running.id)
    }
  }

  const manager = {
    create(body, context = {}) {
      if (!body?.sessionId) throw Object.assign(new Error('sessionId_required'), { code: 'invalid_request' })
      if (!body?.clientRequestId) throw Object.assign(new Error('clientRequestId_required'), { code: 'invalid_request' })
      const active = store.findActiveBySession(body.sessionId)
      if (active) {
        if (active.clientRequestId === body.clientRequestId) return active
        throw Object.assign(new Error('session_busy'), { code: 'session_busy', activeRunId: active.id })
      }

      const existing = store.list().find(run => run.sessionId === body.sessionId && run.clientRequestId === body.clientRequestId)
      if (existing) return existing
      const run = store.create({ ...body, ownerId: instanceId, backgroundRecovery: newRecoveryPolicy(workspaceScope(), body.backgroundRecovery !== false) })
      effects?.initialize?.(run.id)
      if (TERMINAL.has(run.status) || executions.has(run.id)) return run
      const control = makeControl(run, body, context)
      executions.set(run.id, control)
      queueMicrotask(() => start(control))
      return run
    },
    get(runId) { return store.get(runId) },
    list() { return store.list() },
    readAfter(runId, after) { return eventLog.readAfter(runId, after) },
    subscribe(runId, listener) { return eventLog.subscribe(runId, listener) },
    stop(runId) {
      const run = store.get(runId)
      if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' })
      if (TERMINAL.has(run.status)) return run
      recovery.cancel(runId)
      const control = executions.get(runId)
      if (control?.stopRequested) return store.get(runId)
      if (control) control.stopRequested = true
      const stopping = store.update(runId, { status: 'stopping', stopRequestedAt: new Date().toISOString() })
      if (control?.close) control.close()
      else if (!control) finish(runId, 'stopped', { reason: 'execution_missing' })
      return stopping
    },
    recover() {
      const stoppingIds = new Set(store.list().filter(run => run.status === 'stopping').map(run => run.id))
      const orphaned = store.markOrphanedInterrupted(instanceId)
      return orphaned.map(run => {
        if (run.stopRequestedAt || stoppingIds.has(run.id)) {
          const stopped = store.update(run.id, { status: 'stopped', resumeAvailable: false, error: null, stoppedAt: new Date().toISOString() })
          append(stopped, 'stopped', { reason: 'user_stop_before_restart' })
          return stopped
        }
        if (recovery.trySchedule(run, 'server_restarted')) return store.get(run.id)
        append(run, 'interrupted', { reason: 'server_restarted' })
        return store.update(run.id, { observability: deriveRunObservability(run, eventLog.readAfter(run.id, 0)) })
      })
    },
    resume(runId, context = {}) {
      const current = store.get(runId)
      if (!current) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' })
      if (TERMINAL.has(current.status) && !current.resumeAvailable) return current
      if (!current.resumeAvailable) throw Object.assign(new Error('resume_unavailable'), { code: 'resume_unavailable' })
      if (store.findActiveBySession(current.sessionId)) throw Object.assign(new Error('session_busy'), { code: 'session_busy', activeRunId: store.findActiveBySession(current.sessionId).id })
      const request = current.request
      if (!request?.message && !current.input?.messagePreview) throw Object.assign(new Error('resume_request_missing'), { code: 'resume_unavailable' })
      const checkpoint = current.checkpoint || {}
      recovery.cancel(runId)
      const nextAttempt = Number.isInteger(checkpoint.attempt) ? checkpoint.attempt + 1 : 1
      const queued = store.update(runId, {
        status: 'queued',
        ownerId: instanceId,
        resumeAvailable: false,
        error: null,
        pauseReason: null,
        pauseMessage: null,
        interruptedAt: null,
        failedAt: null,
        completedAt: null,
        observability: null,
        stopRequestedAt: null,
        checkpoint: { ...checkpoint, phase: 'resuming', step: 'resume', attempt: nextAttempt, updatedAt: new Date().toISOString() },
      })
      append(queued, 'resumed', { attempt: nextAttempt, from: checkpoint.step || 'unknown' })
      const body = {
        ...(request || {}),
        message: request?.message || current.input?.messagePreview || '',
        sessionId: current.sessionId,
        clientRequestId: current.clientRequestId,
        stream: true,
        resume: true,
      }
      return enqueue(queued, body, context)
    },
    disableRecovery(runId) { return recovery.disable(runId) },
    dispose() { recovery.dispose() },
  }
  recovery = createBackgroundRecovery({ store, effects, workspaceScope, instanceId, append, scheduleRecovery, resume: id => manager.resume(id, { automaticRecovery: true }) })
  return manager
}
