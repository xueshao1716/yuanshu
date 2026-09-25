import { inWorkspace, intakeText } from './learning-intake.mjs'

const ACTIVE = new Set(['queued', 'running', 'stopping'])
// One summary per run, not another event ledger. Existing run files remain truth.
export function buildPersistentActivity(runs, wsRoot, limit = 60) {
  const visible = runs.filter(run => inWorkspace(run, wsRoot))
  const events = visible.map(run => ({
    id: `run:${run.id}`, runId: run.id, sessionId: run.sessionId,
    source: 'run-ledger', type: run.status,
    ts: run[`${run.status}At`] || run.updatedAt || run.createdAt,
    data: { text: intakeText(run.input?.messagePreview) || '任务', engine: intakeText(run.observability?.engine, 50) || null },
  })).sort((a, b) => new Date(a.ts) - new Date(b.ts)).slice(-limit)
  return { events, activeCount: visible.filter(r => ACTIVE.has(r.status)).length }
}
