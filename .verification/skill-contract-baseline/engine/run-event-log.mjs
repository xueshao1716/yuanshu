import fs from 'node:fs'
import path from 'node:path'

import { sanitizeText } from './sanitize.mjs'
import { withoutLegacyReferenceMedia } from './legacy-media-events.mjs'

const SENSITIVE_KEY = /^(authorization|api[_-]?key|token|password|secret)$/i

function sanitizeEventData(type, data, omitLarge = true) {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? sanitizeText(data) : data
  const clean = {}
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY.test(key)) {
      clean[key] = '[REDACTED]'
    } else if (type === 'image' && key === 'data' && typeof value === 'string' && value.length > 8_192) {
      if (omitLarge) {
        clean.omitted = true
        clean.size = value.length
      } else {
        clean[key] = value
      }
    } else if (typeof value === 'string') {
      clean[key] = sanitizeText(value)
    } else if (Array.isArray(value)) {
      clean[key] = value.map(item => sanitizeEventData(type, item, omitLarge))
    } else if (value && typeof value === 'object') {
      clean[key] = sanitizeEventData(type, value, omitLarge)
    } else {
      clean[key] = value
    }
  }
  return clean
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function readValidLines(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') }
  catch { return [] }
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) }
    catch { return null }
  }).filter(Boolean)
}

export function createRunEventLog({ rootDir, now = () => new Date().toISOString() }) {
  const eventsDir = path.join(rootDir, 'events')
  const subscribers = new Map()
  const lastSeqByRun = new Map()
  let closed = false
  fs.mkdirSync(eventsDir, { recursive: true })

  const fileFor = runId => path.join(eventsDir, `${safeId(runId)}.jsonl`)
  const getLastSeq = runId => {
    if (lastSeqByRun.has(runId)) return lastSeqByRun.get(runId)
    const last = readValidLines(fileFor(runId)).reduce(
      (value, event) => Number.isInteger(event.seq) && event.seq > value ? event.seq : value,
      0,
    )
    lastSeqByRun.set(runId, last)
    return last
  }

  function repairIncompleteTail(file) {
    let raw
    try { raw = fs.readFileSync(file, 'utf8') }
    catch { return }
    if (!raw || raw.endsWith('\n')) return
    const lastNewline = raw.lastIndexOf('\n')
    const tail = raw.slice(lastNewline + 1)
    try {
      JSON.parse(tail)
      fs.appendFileSync(file, '\n', 'utf8')
    } catch {
      fs.truncateSync(file, lastNewline < 0 ? 0 : Buffer.byteLength(raw.slice(0, lastNewline + 1), 'utf8'))
    }
  }

  return {
    append({ runId, sessionId, type, data }) {
      if (closed) throw new Error('run_event_log_closed')
      if (!runId || !sessionId || !type) throw new Error('invalid_run_event')
      const file = fileFor(runId)
      repairIncompleteTail(file)
      const liveData = sanitizeEventData(type, data ?? {}, false)
      const event = {
        v: 1,
        runId,
        sessionId,
        seq: getLastSeq(runId) + 1,
        type,
        ts: now(),
        data: sanitizeEventData(type, data ?? {}, true),
      }
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
      lastSeqByRun.set(runId, event.seq)
      const liveEvent = liveData === event.data ? event : { ...event, data: liveData }
      for (const listener of subscribers.get(runId) || []) {
        try { listener(liveEvent) } catch {}
      }
      return event
    },
    readAfter(runId, after = 0) {
      return withoutLegacyReferenceMedia(readValidLines(fileFor(runId))).filter(event => event.seq > after)
    },
    getLastSeq,
    subscribe(runId, listener) {
      if (closed) throw new Error('run_event_log_closed')
      const listeners = subscribers.get(runId) || new Set()
      listeners.add(listener)
      subscribers.set(runId, listeners)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) subscribers.delete(runId)
      }
    },
    close() {
      closed = true
      subscribers.clear()
      lastSeqByRun.clear()
    },
  }
}
