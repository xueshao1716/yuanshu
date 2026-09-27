import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { atomicWriteJson } from './atomic-io.mjs'

const MAX_RESULT_TEXT = 12_000

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'undefined') return null
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => canonicalize(item, seen))
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key], seen)
  return out
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function hashArgs(args) {
  return crypto.createHash('sha256').update(canonicalJson(args)).digest('hex')
}

/**
 * Stable logical step identity. The ordinal is deliberately part of the key:
 * two identical calls in one model turn are two effects, while a resumed call
 * with a new provider toolCallId still resolves to the same journal entry.
 */
export function canonicalStepKey(name, args, { turn = 0, index = 0 } = {}) {
  return `${String(name || '')}:t${Number.isInteger(turn) ? turn : 0}:i${Number.isInteger(index) ? index : 0}:a${hashArgs(args)}`
}

function safeResult(result) {
  if (result === null || typeof result === 'undefined') return result
  if (typeof result === 'string') return result.slice(0, MAX_RESULT_TEXT)
  if (typeof result !== 'object') return result
  const out = {}
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') out[key] = value.slice(0, MAX_RESULT_TEXT)
    else if (Array.isArray(value)) out[key] = value.slice(0, 50)
    else if (value && typeof value === 'object') out[key] = safeResult(value)
    else out[key] = value
  }
  return out
}

export function createRunEffects({ rootDir, now = () => new Date().toISOString() } = {}) {
  if (!rootDir) throw new Error('run_effects_root_required')
  const effectsDir = path.join(rootDir, 'effects')
  fs.mkdirSync(effectsDir, { recursive: true })
  const fileFor = runId => path.join(effectsDir, `${safeId(runId)}.json`)

  const valid = (value, runId) => value?.v === 1 && value.runId === runId && value.steps && typeof value.steps === 'object'
    && !Array.isArray(value.steps) && Object.entries(value.steps).every(([key, step]) => step?.key === key)
  const load = (runId, strict = false) => {
    try {
      const value = JSON.parse(fs.readFileSync(fileFor(runId), 'utf8'))
      if (valid(value, runId)) return value
    } catch {}
    if (strict && fs.existsSync(fileFor(runId))) throw new Error('effects_ledger_invalid')
    return { v: 1, runId, steps: {} }
  }
  const save = doc => atomicWriteJson(fileFor(doc.runId), doc)

  const get = (runId, key) => load(runId).steps[key] || null
  const list = runId => Object.values(load(runId).steps)

  return {
    get,
    list,
    initialize(runId) {
      if (!fs.existsSync(fileFor(runId))) save({ v: 1, runId, steps: {} })
    },
    inspect(runId) {
      try {
        const doc = JSON.parse(fs.readFileSync(fileFor(runId), 'utf8'))
        if (!valid(doc, runId)) return { ok: false }
        return { ok: true, steps: Object.values(doc.steps) }
      } catch { return { ok: false } }
    },
    begin(runId, key, metadata = {}) {
      if (!runId || !key) throw new Error('run_effect_key_required')
      const doc = load(runId, true)
      const existing = doc.steps[key]
      if (existing?.state === 'completed') {
        return { action: 'reuse', key, state: existing.state, result: existing.result, entry: existing }
      }
      if (existing?.state === 'started' || existing?.state === 'uncertain') {
        return { action: 'blocked', key, state: existing.state, reason: existing.state === 'uncertain' ? 'uncertain' : 'in_flight', entry: existing }
      }
      const entry = {
        key,
        state: 'started',
        toolName: String(metadata.toolName || ''),
        argsHash: metadata.argsHash || null,
        ordinal: Number.isInteger(metadata.ordinal) ? metadata.ordinal : null,
        turn: Number.isInteger(metadata.turn) ? metadata.turn : null,
        replayPolicy: metadata.replayPolicy || 'never',
        startedAt: now(),
        attempt: Number.isInteger(metadata.attempt) ? metadata.attempt : 0,
      }
      doc.steps[key] = entry
      save(doc)
      return { action: 'execute', key, state: entry.state, entry }
    },
    complete(runId, key, result, metadata = {}) {
      const doc = load(runId, true)
      const previous = doc.steps[key] || { key }
      const entry = {
        ...previous,
        ...metadata,
        key,
        state: 'completed',
        result: safeResult(result),
        completedAt: now(),
      }
      doc.steps[key] = entry
      save(doc)
      return entry
    },
    markUncertain(runId, key, reason = 'unknown') {
      const doc = load(runId, true)
      const previous = doc.steps[key] || { key }
      const entry = { ...previous, key, state: 'uncertain', reason: String(reason), uncertainAt: now() }
      doc.steps[key] = entry
      save(doc)
      return entry
    },
  }
}

