const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted'])
import { publicRecovery } from './run-recovery.mjs'

function publicRun(run) {
  if (!run) return run
  const { request, ...safe } = run
  if (safe.backgroundRecovery) safe.backgroundRecovery = publicRecovery(safe.backgroundRecovery)
  if (safe.checkpoint && typeof safe.checkpoint === 'object') {
    const { historySnapshot, team, ...checkpoint } = safe.checkpoint
    if (team) checkpoint.team = { launchId: team.launchId }
    if (Array.isArray(checkpoint.toolPlan)) {
      checkpoint.toolPlan = checkpoint.toolPlan.map(step => {
        if (!step || typeof step !== 'object') return step
        const { args, ...publicStep } = step
        return publicStep
      })
    }
    safe.checkpoint = checkpoint
  }
  return safe
}
import { buildRunSnapshot, summarizeRun } from './run-observability.mjs'
import { buildWorkExplanation } from './work-explanation.mjs'

function cursorFrom(req, url) {
  const query = Number.parseInt(url?.searchParams?.get('after') || '0', 10)
  const header = Number.parseInt(String(req?.headers?.['last-event-id'] || '0'), 10)
  return Math.max(Number.isFinite(query) ? query : 0, Number.isFinite(header) ? header : 0, 0)
}

function writeEvent(res, event) {
  res.write(`id: ${event.seq}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function lastSeqOf(manager, runId) {
  if (typeof manager?.readAfter !== 'function') return 0
  const events = manager.readAfter(runId, 0)
  return Array.isArray(events) ? (events.at(-1)?.seq || 0) : 0
}

export function createRunApi({ manager, json, readContext = null, readDeliveries = null }) {
  const deliveryView = async (run, events) => {
    try { return { deliveries: await readDeliveries?.(run, events) || [] } }
    catch { return { deliveries: [], deliveriesUnavailable: true } }
  }
  // explain 记忆（2026-09-20）：/api/run/overview 冷启 8.9s，大头是对每个可见 run 重算 explain
  //（readContext 要读上下文）。同一 run 的同一末序号（lastSeq）结果不变，直接复用。
  const explainCache = new Map()
  const explain = async (run, events) => {
    const lastSeq = Array.isArray(events) && events.length ? (events[events.length - 1]?.seq || 0) : 0
    const key = `${run && run.id}:${lastSeq}`
    const hit = explainCache.get(key)
    if (hit) return hit
    let context = {}
    try { context = await readContext?.(run) || {} } catch { context = { unavailable: true } }
    const built = buildWorkExplanation(run, events, context)
    if (explainCache.size > 200) explainCache.clear()
    explainCache.set(key, built)
    return built
  }
  return {
    async overview(res, _req, url) {
      const sessionId = url?.searchParams?.get('session')
      const runs = (typeof manager.list === 'function' ? manager.list() : []).filter(run => !sessionId || run.sessionId === sessionId)
      const eventsByRun = new Map(runs.map(run => [run.id, manager.readAfter(run.id, 0)]))
      const snapshot = buildRunSnapshot(runs, eventsByRun)
      const sources = new Map(runs.map(run => [run.id, run]))
      const visible = new Map([...snapshot.active, ...snapshot.recent].map(run => [run.id, run]))
      await Promise.all([...visible.values()].map(async run => {
        const source = sources.get(run.id), events = eventsByRun.get(run.id)
        run.explanation = await explain(source, events)
        Object.assign(run, await deliveryView(source, events))
      }))
      return json(res, 200, snapshot)
    },
    async create(res, body, req = null) {
      try {
        const run = manager.create(body, { headers: req?.headers, socket: req?.socket })
        return json(res, 202, {
          runId: run.id,
          sessionId: run.sessionId,
          status: run.status,
          lastSeq: 0,
        })
      } catch (error) {
        if (error?.code === 'session_busy') {
          return json(res, 409, { error: 'session_busy', activeRunId: error.activeRunId })
        }
        if (error?.code === 'invalid_request') return json(res, 400, { error: error.message })
        throw error
      }
    },
    async get(res, runId) {
      const run = manager.get(runId)
      if (!run) return json(res, 404, { error: 'run_not_found' })
      const events = manager.readAfter?.(runId, 0) || []
      return json(res, 200, { ...publicRun(run), ...summarizeRun(run, events), explanation: await explain(run, events), ...await deliveryView(run, events), lastSeq: events.at(-1)?.seq || 0 })
    },
    events(res, req, url, runId) {
      const run = manager.get(runId)
      if (!run) return json(res, 404, { error: 'run_not_found' })
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })

      let cursor = cursorFrom(req, url)
      let replaying = true
      const queued = []
      const send = event => {
        if (event.seq <= cursor || res.writableEnded) return
        writeEvent(res, event)
        cursor = event.seq
      }
      const unsubscribe = manager.subscribe(runId, event => {
        if (replaying) queued.push(event)
        else send(event)
      })
      for (const event of manager.readAfter(runId, cursor)) send(event)
      replaying = false
      for (const event of queued) send(event)

      const latest = manager.get(runId)
      if (TERMINAL.has(latest?.status)) {
        unsubscribe()
        res.end()
        return
      }
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 20_000)
      heartbeat.unref?.()
      const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
        if (!res.writableEnded) res.end()
      }
      req.once('close', close)
    },
    disableRecovery(res, runId) {
      try { return json(res, 200, publicRun(manager.disableRecovery(runId))) }
      catch (error) {
        if (error?.code === 'run_not_found') return json(res, 404, { error: 'run_not_found' })
        throw error
      }
    },
    stop(res, runId) {
      try {
        return json(res, 200, publicRun(manager.stop(runId)))
      } catch (error) {
        if (error?.code === 'run_not_found') return json(res, 404, { error: 'run_not_found' })
        throw error
      }
    },
    resume(res, runId, req = null) {
      try {
        const run = manager.resume(runId, { headers: req?.headers, socket: req?.socket })
        return json(res, 200, { ...publicRun(run), lastSeq: lastSeqOf(manager, runId) })
      } catch (error) {
        if (error?.code === 'run_not_found') return json(res, 404, { error: 'run_not_found' })
        if (error?.code === 'resume_unavailable') return json(res, 409, { error: 'resume_unavailable' })
        if (error?.code === 'session_busy') return json(res, 409, { error: 'session_busy', activeRunId: error.activeRunId })
        throw error
      }
    },
  }
}
