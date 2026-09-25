import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson } from './atomic-io.mjs'
import { scopeKey } from './run-recovery.mjs'
import { sanitizeText } from './sanitize.mjs'

export const intakeText = (value, limit = 200) => sanitizeText(String(value || '')
  .replace(/https?:\/\/[^\s<>]+/g, url => url.split(/[?#]/)[0])).slice(0, limit)
export const inWorkspace = (run, wsRoot) => !!run?.backgroundRecovery?.scope
  && scopeKey(run.backgroundRecovery.scope) === scopeKey(wsRoot)

// Local references only: no model invocation, adoption, or fabricated quality labels.
export function createLearningIntake({ wsRoot, store, limit = 500 }) {
  const file = path.join(wsRoot, '记忆', '运行时', '待提炼任务.json')
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data.v !== 1 || !Array.isArray(data.entries)) throw Error('Invalid intake state')
      return data
    } catch (e) { if (e.code === 'ENOENT') return { v: 1, entries: [], retired: 0 }; throw e }
  }
  const eligible = run => run?.status === 'completed' && inWorkspace(run, wsRoot)
  function enqueue(run) {
    if (!eligible(run) || run.learningIntake?.state === 'queued') return
    const data = read()
    if (!data.entries.some(e => e.runId === run.id && e.sessionId === run.sessionId)) {
      data.entries.push({ runId: run.id, sessionId: run.sessionId, state: 'pending',
        at: run.completedAt || run.updatedAt, title: intakeText(run.input?.messagePreview) || '已完成任务',
        source: 'run-ledger' })
      data.entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
      const excess = Math.max(0, data.entries.length - limit)
      data.retired += excess
      data.entries = data.entries.slice(-limit)
      data.updatedAt = new Date().toISOString()
      atomicWriteJson(file, data)
    }
    // Mark only after queue persistence; restart reconciliation repairs the gap.
    store.update(run.id, { learningIntake: { state: 'queued', at: new Date().toISOString() } })
  }
  async function reconcile() {
    const runs = store.list().filter(r => eligible(r) && r.learningIntake?.state !== 'queued')
      .sort((a, b) => new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt)).slice(0, 100)
    for (const run of runs) {
      try { enqueue(run) }
      catch { store.update(run.id, { learningIntake: { state: 'failed', reason: 'candidate_write_failed' } }) }
      await new Promise(r => setImmediate(r))
    }
  }
  return { enqueue, reconcile,
    status() {
      const pending = store.list().filter(r => eligible(r) && r.learningIntake?.state !== 'queued')
      const backlog = { backlog: pending.length, failed: pending.filter(r => r.learningIntake?.state === 'failed').length }
      try {
        const data = read()
        return { ...backlog, ok: true, count: data.entries.length, limit, retired: data.retired, updatedAt: data.updatedAt || null,
          entries: data.entries.slice().reverse() }
      } catch { return { ...backlog, ok: false, reason: 'candidate_state_unreadable', count: 0, entries: [] } }
    },
  }
}
