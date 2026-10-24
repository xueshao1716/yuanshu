import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { atomicWriteJson } from './atomic-io.mjs'
import { withLegacyContinuation } from './task-continuation.mjs'
import { createRunActivityReader } from './run-activity.mjs'

const ACTIVE_STATUSES = new Set(['queued', 'running', 'stopping'])

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
  const list = () => {
    let names = []
    try { names = fs.readdirSync(runsDir).filter(name => name.endsWith('.json')) } catch { return [] }
    // 丢掉已删除文件的缓存，避免缓存无限增长
    if (parseCache.size > names.length + 50) {
      const alive = new Set(names)
      for (const key of parseCache.keys()) if (!alive.has(key)) parseCache.delete(key)
    }
    return names.map(readOne).filter(Boolean)
  }

  // Display-only reader: bounded asynchronous IO keeps overview polling off
  // the event loop. Admission continues to use the strict synchronous snapshot.
  const listAsync = async () => {
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
    return runs
  }

  // Admission must see every durable claim; display-oriented list/get may
  // skip unreadable records, but capacity decisions must fail closed instead.
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
      const run = {
        v: 1,
        id: idFactory(),
        sessionId: input.sessionId,
        clientRequestId: input.clientRequestId,
        ownerId: input.ownerId || null,
        status: 'queued',
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
      const orphaned = list().filter(run => (
        ACTIVE_STATUSES.has(run.status) && run.ownerId !== currentOwnerId
      ))
      return orphaned.map(run => update(run.id, {
        status: 'interrupted',
        interruptedAt: now(),
        error: 'server_restarted',
        resumeAvailable: true,
        checkpoint: checkpointFor(run, { phase: 'interrupted', step: 'recover', updatedAt: now() }),
      }))
    },
  }
}
