const PHASE_BY_EVENT = new Map([
  ['run_started', 'executing'],
  ['reasoning', 'thinking'],
  ['tool_started', 'executing'],
  ['tool_finished', 'executing'],
  ['handoff', 'executing'],
  ['memory_written', 'remembering'],
  ['artifact_created', 'delivering'],
  ['session_updated', 'delivering'],
  ['completed', 'completed'],
  ['failed', 'failed'],
  ['stopped', 'stopped'],
  ['interrupted', 'interrupted'],
])

const ACTIVE = new Set(['queued', 'running', 'stopping'])
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted'])
const TOOL_START_EVENTS = new Set(['tool', 'tool_start', 'tool_started'])
const TOOL_END_EVENTS = new Set(['tool_end', 'tool_finished', 'tool_finished'])

function finiteDate(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  return Number.isFinite(time) ? time : null
}

function safeModel(value) {
  if (!value) return null
  if (typeof value === 'string') {
    const slash = value.indexOf('/')
    if (slash > 0 && slash < value.length - 1) {
      return { provider: value.slice(0, slash), id: value.slice(slash + 1) }
    }
    return { provider: '', id: value }
  }
  if (typeof value !== 'object') return null
  const provider = String(value.provider || '').trim()
  const id = String(value.id || value.model || '').trim()
  if (!provider && !id) return null
  return { provider, id }
}

function safeTool(eventType, data) {
  if (!data || typeof data !== 'object') return null
  if (!TOOL_START_EVENTS.has(eventType) && !TOOL_END_EVENTS.has(eventType)) return null
  const result = {}
  if (data.id != null && String(data.id)) result.id = String(data.id)
  if (data.name != null && String(data.name)) result.name = String(data.name)
  if (!result.id && !result.name) return null
  result.status = TOOL_END_EVENTS.has(eventType)
    ? (data.isError === true ? 'error' : 'completed')
    : 'started'
  return result
}

export function classifyFailure(message, status = 'failed') {
  if (status === 'stopped') return 'stopped'
  if (status === 'interrupted') return 'interrupted'
  const text = String(message || '').toLowerCase()
  if (!text) return status === 'failed' ? 'unknown' : null
  if (/timeout|timed out|etimedout|超时|504/.test(text)) return 'timeout'
  if (/approval|permission|sandbox|确认|权限|审批/.test(text)) return 'approval'
  if (/tool|工具/.test(text)) return 'tool'
  if (/401|403|429|quota|rate.?limit|api.?key|鉴权|额度|密钥/.test(text)) return 'provider'
  if (/network|fetch|econn|socket|连接|网络/.test(text)) return 'transport'
  if (/model|模型|llm|上游|http \d{3}/.test(text)) return 'model'
  return 'unknown'
}

function terminalTimestamp(run, events) {
  const field = run?.status === 'completed' ? run.completedAt
    : run?.status === 'failed' ? run.failedAt
      : run?.status === 'stopped' ? run.stoppedAt
        : run?.status === 'interrupted' ? run.interruptedAt : null
  const persisted = finiteDate(field)
  if (persisted != null) return persisted
  const terminalEvent = [...events].reverse().find(event => TERMINAL.has(String(event?.type || '')))
  return finiteDate(terminalEvent?.ts)
}

export function deriveRunObservability(run, events = [], now = Date.now()) {
  const list = Array.isArray(events) ? events : []
  const eventCounts = {}
  let lastModel = safeModel(run?.observability?.lastModel) || safeModel(run?.input?.model)
  let textModel = safeModel(run?.observability?.textModel)
  let requestedModel = safeModel(run?.observability?.requestedModel) || safeModel(run?.input?.model)
  let engine = String(run?.observability?.engine || '').trim() || null
  const mediaModels = []
  const mediaModelKeys = new Set()
  let lastTool = run?.observability?.lastTool || null
  let failureCategory = run?.observability?.failureCategory || null
  for (const event of list) {
    const type = String(event?.type || '')
    if (!type) continue
    eventCounts[type] = (eventCounts[type] || 0) + 1
    const data = event?.data
    if (data?.requestedModel) requestedModel = safeModel(data.requestedModel) || requestedModel
    if (type === 'engine_selected' && data?.engine) engine = String(data.engine).trim() || engine
    const model = safeModel(data?.model || data?.usedModel || (data?.provider && data?.id ? data : null))
    const mediaModel = safeModel(data?.media?.model || (['media', 'media_started', 'media_completed', 'image', 'video', 'audio'].includes(type) ? data?.model : null))
    if (mediaModel) {
      const key = `${mediaModel.provider}/${mediaModel.id}`
      if (!mediaModelKeys.has(key)) { mediaModelKeys.add(key); mediaModels.push(mediaModel) }
    }
    if (model && !mediaModel) {
      lastModel = model
      if (['model_used', 'model_switched', 'done', 'completed'].includes(type)) textModel = model
    }
    const tool = safeTool(type, data)
    if (tool) lastTool = tool
    if (type === 'error' || type === 'failed') {
      failureCategory = classifyFailure(data?.message || data?.error || run?.error, run?.status || 'failed')
    }
  }

  const startedAt = finiteDate(run?.startedAt) ?? finiteDate(list.find(event => event?.type === 'run_started')?.ts) ?? finiteDate(run?.createdAt)
  let durationMs = Number(run?.observability?.durationMs)
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    const endedAt = terminalTimestamp(run, list)
    const end = endedAt ?? (ACTIVE.has(run?.status) ? now : null)
    durationMs = startedAt != null && end != null ? Math.max(0, Math.round(end - startedAt)) : null
  }
  if (!TERMINAL.has(run?.status) && startedAt != null) {
    durationMs = Math.max(0, Math.round(now - startedAt))
  }
  const terminalFailure = ['failed', 'stopped', 'interrupted'].includes(run?.status) && !run?.pauseReason

  return {
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    eventCounts: Object.fromEntries(Object.entries(eventCounts).sort(([a], [b]) => a.localeCompare(b))),
    engine,
    requestedModel,
    textModel,
    mediaModels,
    lastModel,
    lastTool,
    failureCategory: terminalFailure ? (failureCategory || classifyFailure(run?.error, run?.status)) : null,
  }
}

export function phaseFromEvent(type) {
  return PHASE_BY_EVENT.get(String(type || '')) || 'executing'
}

function latestPhase(run, events) {
  const lastEvent = events.at(-1)
  if (lastEvent?.type) return phaseFromEvent(lastEvent.type)
  if (run?.status === 'queued') return 'queued'
  if (run?.status === 'running' || run?.status === 'stopping') return 'executing'
  return phaseFromEvent(run?.status)
}

export function summarizeRun(run, events = []) {
  const list = Array.isArray(events) ? events : []
  const toolCount = list.filter(event => TOOL_START_EVENTS.has(String(event?.type || ''))).length
  const memoryEvents = list.filter(event => event?.type === 'memory_written')
  const memoryCount = memoryEvents.reduce((total, event) => {
    const count = Number(event?.data?.count)
    return total + (Number.isFinite(count) && count >= 0 ? count : 1)
  }, 0)
  const memoryPreview = memoryEvents.map(event => event?.data?.preview || event?.data?.summary || event?.data?.text).find(Boolean)
  const attemptStart = list.findLastIndex(event => event?.type === 'resumed')
  const lastError = list.slice(attemptStart + 1).reverse().find(event => event?.type === 'error' || event?.type === 'failed')
  const error = run?.pauseReason ? null : run?.error || lastError?.data?.message || lastError?.data?.error || null
  const observability = deriveRunObservability(run, list)
  return {
    id: run?.id || '',
    sessionId: run?.sessionId || '',
    status: run?.status || 'unknown',
    phase: latestPhase(run, list),
    messagePreview: run?.input?.messagePreview || '',
    toolCount,
    memoryCount,
    memoryPreview: memoryPreview ? String(memoryPreview).slice(0, 160) : null,
    error: error ? String(error).slice(0, 240) : null,
    resumeAvailable: run?.resumeAvailable === true,
    ...(run?.pauseReason ? { pauseReason: run.pauseReason } : {}),
    ...(run?.pauseMessage ? { pauseMessage: run.pauseMessage } : {}),
    durationMs: observability.durationMs,
    eventCounts: observability.eventCounts,
    engine: observability.engine,
    requestedModel: observability.requestedModel,
    textModel: observability.textModel,
    mediaModels: observability.mediaModels,
    lastModel: observability.lastModel,
    lastTool: observability.lastTool,
    failureCategory: observability.failureCategory,
  }
}

export function buildRunSnapshot(runs = [], eventsByRun = new Map()) {
  const list = Array.isArray(runs) ? runs : []
  const sorted = [...list].sort((a, b) => String(b?.updatedAt || b?.createdAt || '').localeCompare(String(a?.updatedAt || a?.createdAt || '')))
  const summaries = sorted.map(run => summarizeRun(run, eventsByRun.get(run.id) || []))
  const active = summaries.filter(run => ACTIVE.has(run.status))
  const failedCount = summaries.filter(run => ['failed', 'interrupted'].includes(run.status) && !run.pauseReason).length
  return {
    active,
    recent: summaries.slice(0, 8),
    health: {
      status: active.length ? 'busy' : failedCount ? 'degraded' : 'idle',
      activeCount: active.length,
      failedCount,
    },
  }
}
