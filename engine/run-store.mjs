import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { atomicWriteJson } from './atomic-io.mjs'
import { withLegacyContinuation } from './task-continuation.mjs'
import { createRunActivityReader } from './run-activity.mjs'
import { deriveRunTitle } from './run-title.mjs'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'stopping'])
// 内部轮次（定时任务/子代理/值班唤醒）复用同一套终态词，收尾只认这四个；
// 取消落成 stopped（run-api 的 TERMINAL 也认它），不另造第五种状态。
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted'])
const TERMINAL_STAMP = { completed: 'completedAt', failed: 'failedAt', stopped: 'stoppedAt', interrupted: 'interruptedAt' }

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function persistedInput(input) {
  return {
    messagePreview: String(input.message || '').slice(0, 500),
    model: input.model || null,
    attachments: Array.isArray(input.files)
      ? input.files.map(file => ({ path: String(file?.path || '') })).filter(file => file.path)
      : [],
  }
}

function persistedRequest(input) {
  const request = {
    sessionId: String(input.sessionId || ''),
    clientRequestId: String(input.clientRequestId || ''),
    message: String(input.message || ''),
    model: input.model || null,
    params: input.params && typeof input.params === 'object' ? { ...input.params } : undefined,
    workflow: ['team-video', 'team-general'].includes(input.workflow) ? input.workflow : undefined,
    origin: ['knowledge', 'cultivation'].includes(input.origin) ? input.origin : undefined,
    files: Array.isArray(input.files)
      ? input.files.map(file => ({ path: String(file?.path || '') })).filter(file => file.path)
      : undefined,
  }
  return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined))
}

/**
 * runId → 人读的任务名。看门狗（server 的 runTitleForWatchdog）与测试共用这一份：
 *   · 新记录直接用落盘的 title；
 *   · 老记录按同一套 deriveRunTitle 规则从消息预览/来源补；
 *   · 内部轮次（kind:'internal'）从 internal 元数据补（label/name/task）。
 * 查不到 / 读盘失败 → 空串（不猜），通知里会明说「这轮没带名字」。
 */
export function runTitleOf(store, runId) {
  try {
    const run = store?.get?.(String(runId || ''))
    if (!run) return ''
    if (run.title) return String(run.title)
    const at = Date.parse(String(run.createdAt || ''))
    const internal = run.kind === 'internal' && run.internal && typeof run.internal === 'object' ? run.internal : null
    return deriveRunTitle({
      title: internal?.title,
      task: internal?.task,
      label: internal?.label,
      name: internal?.name,
      message: run.input?.messagePreview || '',
      surface: run.surface,
      at: Number.isFinite(at) ? at : undefined,
    })
  } catch { return '' }
}

function checkpointFor(run, patch = {}) {
  const current = run?.checkpoint || {
    phase: run?.status || 'queued',
    step: 'create',
    attempt: 0,
    updatedAt: run?.createdAt || null,
  }
  const checkpoint = {
    phase: patch.phase || current.phase || 'queued',
    step: patch.step || current.step || 'create',
    attempt: Number.isInteger(patch.attempt) && patch.attempt >= 0 ? patch.attempt : (current.attempt || 0),
    updatedAt: patch.updatedAt || current.updatedAt || run?.updatedAt || run?.createdAt || null,
  }
  for (const key of ['team', 'turn', 'lastEventSeq', 'pendingSteps', 'completedSteps', 'uncertainSteps', 'checkpointKind', 'toolPlan', 'historySnapshot', 'historyDigest', 'historyCount']) {
    if (patch[key] !== undefined) checkpoint[key] = patch[key]
    else if (current[key] !== undefined) checkpoint[key] = current[key]
  }
  return checkpoint
}

export function createRunStore({ rootDir, now = () => new Date().toISOString(), idFactory = randomUUID }) {
  const runsDir = path.join(rootDir, 'runs')
  fs.mkdirSync(runsDir, { recursive: true })

  const fileFor = id => path.join(runsDir, `${safeId(id)}.json`)
  const get = id => {
    try { return withLegacyContinuation(JSON.parse(fs.readFileSync(fileFor(id), 'utf8'))) }
    catch { return null }
  }
  // 2026-10-24：mtime 缓存。之前每次 list() 都把 222 个 run 文件全读一遍并 JSON.parse，
  // 而界面每 5 秒轮询一次 overview —— 持续产生的垃圾对象正是 GC 长停顿的来源之一。
  const parseCache = new Map() // name -> { mtimeMs, size, data }
  const readOne = (name) => {
    try {
      const st = fs.statSync(path.join(runsDir, name))
      const hit = parseCache.get(name)
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
      const data = withLegacyContinuation(JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8')))
      parseCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, data })
      return data
    } catch { return null }
  }
  // 2026-11-07：内部轮次也复用这张表（kind:'internal'），但**默认不进用户可见列表**。
  // 需要显式传 { includeInternal: true }（恢复/统计/测试用）；用户 run 列表与时间线行为不变。
  const visible = (run, includeInternal) => !!run && (run.kind !== 'internal' || includeInternal)
  const list = ({ includeInternal = false } = {}) => {
    let names = []
    try { names = fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) } catch { return [] }
    // 丢掉已删除文件的缓存，避免缓存无限增长
    if (parseCache.size > names.length + 50) {
      const alive = new Set(names)
      for (const key of parseCache.keys()) if (!alive.has(key)) parseCache.delete(key)
    }
    return names.map(readOne).filter(run => visible(run, includeInternal))
  }

  // Display-only reader: bounded asynchronous IO keeps overview polling off
  // the event loop. Admission continues to use the strict synchronous snapshot.
  const listAsync = async ({ includeInternal = false } = {}) => {
    const names = (await fs.promises.readdir(runsDir)).filter(name => name.endsWith('.json'))
    const runs = []
    for (let start = 0; start < names.length; start += 16) {
      const batch = await Promise.all(names.slice(start, start + 16).map(async name => {
        try {
          const st = await fs.promises.stat(path.join(runsDir, name))
          const hit = parseCache.get(name)
          if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
          const data = withLegacyContinuation(JSON.parse(await fs.promises.readFile(path.join(runsDir, name), 'utf8')))
          parseCache.set(name, { mtimeMs: st.mtimeMs, size: st.size, data })
          return data
        } catch { return null }
      }))
      runs.push(...batch.filter(Boolean))
    }
    return runs.filter(run => visible(run, includeInternal))
  }

  // Admission must see every durable claim; display-oriented list/get may
  // skip unreadable records, but capacity decisions must fail closed instead.
  // 内部轮次不占用户 run 的并发额度：校验照旧 fail-closed，只在校验通过后排除。
  const readAdmissionSnapshot = () => fs.readdirSync(runsDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const run = JSON.parse(fs.readFileSync(path.join(runsDir, name), 'utf8'))
      if (!run || typeof run !== 'object' || Array.isArray(run)
          || typeof run.id !== 'string' || !run.id.trim()
          || typeof run.status !== 'string' || !run.status.trim()) {
        throw Object.assign(new Error(`invalid_run_record:${name}`), { code: 'invalid_run_record' })
      }
      return withLegacyContinuation(run)
    })
    .filter(run => run.kind !== 'internal')

  const update = (id, patch) => {
    const current = get(id)
    if (!current) throw new Error(`run_not_found:${id}`)
    const updated = { ...current, ...patch, id: current.id, updatedAt: now() }
    atomicWriteJson(fileFor(id), updated)
    return updated
  }

  return {
    create(input) {
      if (!input?.sessionId) throw new Error('sessionId_required')
      if (!input?.clientRequestId) throw new Error('clientRequestId_required')
      const existing = list().find(run => (
        run.sessionId === input.sessionId && run.clientRequestId === input.clientRequestId
      ))
      if (existing) return existing

      const createdAt = now()
      // 2026-11-07：每个 run 都带一个给人看的名字——看门狗只能报 runId 时，
      // 伙伴认不出是哪件事。显式 title 优先，否则按派活文本/定时 label/子代理 name/
      // 用户消息首句/来源+时间兜底（推导规则集中在 run-title.mjs，纯函数）。
      const createdMs = Date.parse(createdAt)
      const title = deriveRunTitle({
        title: input.title,
        task: input.task,
        label: input.label,
        name: input.name,
        message: input.message,
        surface: input.surface,
        at: Number.isFinite(createdMs) ? createdMs : undefined,
      })
      const surface = String(input.surface || '').trim().slice(0, 24)
      const run = {
        v: 1,
        id: idFactory(),
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        ownerId: input.ownerId || null,
        status: 'queued',
        // 顶层 title 是给人看的（≤40 字）；老记录没有这个字段，读时再按同一套规则推导。
        title,
        ...(surface ? { surface } : {}),
        input: persistedInput(input),
        request: persistedRequest(input),
        ...(typeof input.motherIdentityEligible === 'boolean' ? { motherIdentityEligible: input.motherIdentityEligible } : {}),
        ...(input.voiceTaskAdmission ? { voiceTaskAdmission: input.voiceTaskAdmission } : {}),
        ...(input.backgroundRecovery ? { backgroundRecovery: input.backgroundRecovery } : {}),
        ...(input.origin === 'cultivation' && input.cultivation ? { cultivation: input.cultivation } : {}),
        checkpoint: checkpointFor({ status: 'queued', createdAt }),
        resumeAvailable: false,
        createdAt,
        updatedAt: createdAt,
      }
      atomicWriteJson(fileFor(run.id), run)
      return run
    },
    /**
     * 内部轮次（2026-11-07）：定时任务 / 后台子代理 / 值班唤醒是她自己发起的，
     * 以前没有 run 记录、审计行也没有 runId，看门狗只能说"这轮没带 id/名字"。
     * 这里复用同一张表，用 kind:'internal' 标记；默认列表过滤（见 list/listAsync），
     * 生命周期仍是 running → completed/failed/stopped/interrupted，语义与用户 run 一致。
     */
    createInternal(input = {}) {
      const createdAt = now()
      const createdMs = Date.parse(createdAt)
      const internalKind = String(input.internalKind || 'misc').slice(0, 24)
      const refId = String(input.refId || '').slice(0, 120)
      const id = String(input.id || idFactory()).slice(0, 64)
      const title = deriveRunTitle({
        title: input.title,
        task: input.task,
        label: input.label,
        name: input.name,
        surface: input.surface,
        at: Number.isFinite(createdMs) ? createdMs : undefined,
      })
      const surface = String(input.surface || '').trim().slice(0, 24)
      const sessionId = String(input.sessionId || `internal:${internalKind}:${refId || id}`).slice(0, 120)
      const internalMeta = input.internal && typeof input.internal === 'object' ? { ...input.internal } : null
      const run = {
        v: 1,
        id,
        kind: 'internal',
        internalKind,
        ...(refId ? { refId } : {}),
        sessionId,
        clientRequestId: `internal:${id}`,
        ownerId: input.ownerId || null,
        status: 'running',
        // 顶层 title 与用户 run 同义：看门狗/通知里直接说「是哪件事」。
        title,
        ...(surface ? { surface } : {}),
        input: { messagePreview: String(internalMeta?.task || input.task || input.label || input.name || '').slice(0, 500) },
        ...(internalMeta ? { internal: internalMeta } : {}),
        checkpoint: checkpointFor({ status: 'running', createdAt }, { phase: 'executing', step: 'internal', updatedAt: createdAt }),
        resumeAvailable: false,
        startedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }
      atomicWriteJson(fileFor(run.id), run)
      return run
    },
    /** 内部轮次收尾：只写终态，且幂等（重复调用返回已有终态，不覆盖）。 */
    finishInternal(id, { status = 'completed', error = '', errorCode = '', resultPreview = '', at = null } = {}) {
      const current = get(id)
      if (!current) throw new Error(`run_not_found:${id}`)
      const finalStatus = String(status || 'completed')
      if (TERMINAL_STATUSES.has(String(current.status))) return current
      if (!TERMINAL_STATUSES.has(finalStatus)) throw new Error(`invalid_terminal_status:${finalStatus}`)
      const endedAt = at || now()
      const endedMs = Date.parse(endedAt)
      const startedMs = Date.parse(String(current.startedAt || current.createdAt || ''))
      const durationMs = Number.isFinite(endedMs) && Number.isFinite(startedMs) ? Math.max(0, endedMs - startedMs) : 0
      const updated = {
        ...current,
        status: finalStatus,
        endedAt,
        durationMs,
        [TERMINAL_STAMP[finalStatus]]: endedAt,
        error: String(error || '').slice(0, 800),
        errorCode: String(errorCode || (finalStatus === 'completed' ? '' : finalStatus)).slice(0, 80),
        ...(resultPreview ? { resultPreview: String(resultPreview).slice(0, 500) } : {}),
        updatedAt: endedAt,
      }
      atomicWriteJson(fileFor(id), updated)
      return updated
    },
    get,
    update,
    getCheckpoint(id) {
      const run = get(id)
      return run ? checkpointFor(run) : null
    },
    saveCheckpoint(id, patch = {}) {
      const current = get(id)
      if (!current) throw new Error(`run_not_found:${id}`)
      const checkpoint = checkpointFor(current, { ...patch, updatedAt: now() })
      const updated = { ...current, checkpoint, updatedAt: now() }
      atomicWriteJson(fileFor(id), updated)
      return updated
    },
    list,
    listAsync,
    listActivity: createRunActivityReader(runsDir),
    readAdmissionSnapshot,
    findActiveBySession(sessionId) {
      return list().find(run => run.sessionId === sessionId && ACTIVE_STATUSES.has(run.status)) || null
    },
    markOrphanedInterrupted(currentOwnerId) {
      // 内部轮次也要收尾：重启前还在跑的定时任务/子代理/值班轮次不可能还活着。
      const orphaned = list({ includeInternal: true }).filter(run => (
        ACTIVE_STATUSES.has(run.status) && run.ownerId !== currentOwnerId
      ))
      return orphaned.map(run => {
        const at = now()
        return update(run.id, {
          status: 'interrupted',
          interruptedAt: at,
          endedAt: at,
          error: 'server_restarted',
          resumeAvailable: true,
          checkpoint: checkpointFor(run, { phase: 'interrupted', step: 'recover', updatedAt: at }),
        })
      })
    },
  }
}
