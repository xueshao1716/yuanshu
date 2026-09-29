import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { atomicWriteJson } from './atomic-io.mjs'
const locks = new Map()
const claims = new Map()
export const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted', 'blocked'])
export const fail = code => Object.assign(new Error(code), { code })
export const copy = value => structuredClone(value)
export function validateSubmission(input) {
  const bounded = (value, max) => typeof value === 'string' && value.trim() && value.length <= max
  if (!bounded(input?.conversationId, 256) || !bounded(input?.requestId, 256) || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 8) throw fail('invalid_request')
  return input.tasks.map((task, index) => {
    if (!task || Object.keys(task).some(key => !['title', 'instruction', 'dependsOn'].includes(key)) || !bounded(task.title, 200) || !bounded(task.instruction, 12000)) throw fail('invalid_request')
    const dependsOn = task.dependsOn ?? []
    if (!Array.isArray(dependsOn) || dependsOn.length > 7 || dependsOn.some(i => !Number.isInteger(i) || i < 0 || i >= index) || new Set(dependsOn).size !== dependsOn.length) throw fail('invalid_request')
    return { title: task.title, instruction: task.instruction, dependsOn: [...dependsOn].sort((a, b) => a - b) }
  })
}
export function createVoiceTaskStore(rootDir) {
  const file = path.resolve(rootDir, 'voice-tasks', 'journal.json')
  return {
    read() {
      try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.v !== 1 || !Array.isArray(value.groups)) throw fail('invalid_voice_journal'); return value }
      catch (error) { if (error.code === 'ENOENT') return { v: 1, groups: [] }; throw error }
    },
    save(state) { atomicWriteJson(file, state) },
    exclusive(fn) {
      const prior = locks.get(file) || Promise.resolve(), result = prior.then(fn, fn)
      const settled = result.catch(() => {}); locks.set(file, settled)
      void settled.finally(() => { if (locks.get(file) === settled) locks.delete(file) })
      return result
    },
    transaction(fn) {
      return this.exclusive(() => {
        const state = this.read(), result = fn(state)
        if (result?.then) throw fail('async_journal_transaction')
        this.save(state); return copy(result)
      })
    },
    claim(kind, id, fn) {
      const key = file + ':' + kind + ':' + id
      if (claims.has(key)) return Promise.resolve(null)
      const pending = Promise.resolve().then(fn).finally(() => claims.delete(key))
      claims.set(key, pending); return pending
    },
    submit(state, input, tasks) {
      const hash = createHash('sha256').update(JSON.stringify(tasks)).digest('hex')
      const existing = state.groups.find(group => group.conversationId === input.conversationId && group.requestId === input.requestId)
      if (existing) { if (existing.hash !== hash) throw fail('request_conflict'); return existing }
      const group = { id: randomUUID(), conversationId: input.conversationId, requestId: input.requestId, hash, createdAt: new Date().toISOString(), tasks: [] }
      group.tasks = tasks.map((task, index) => { const id = randomUUID(); return { ...task, id, groupId: group.id, conversationId: group.conversationId, index, requirementRevision: 1, sessionId: randomUUID(), runId: null, status: 'queued', sessionReady: false, launchAttempted: false } })
      state.groups.push(group); this.save(state); return group
    },
  }
}
