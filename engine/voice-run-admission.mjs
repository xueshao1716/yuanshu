const terminal = new Set(['completed', 'failed', 'stopped', 'interrupted'])
const normalize = value => value == null ? null : ({
  resourceKey: typeof value.resourceKey === 'string' && value.resourceKey.trim() ? value.resourceKey.trim() : null,
  maxConcurrency: Math.max(1, Math.min(8, Number.isInteger(value.maxConcurrency) ? value.maxConcurrency : 1)),
})

// Synchronous check and store.create/update share one event-loop turn. Claims
// come only from internal execution context and survive restart on the run.
// Resource names are valid only when the executor actually enforces isolation.
export function admitVoiceRun(runs, context = {}, current = null) {
  const candidate = normalize(current?.voiceTaskAdmission ?? context.voiceTaskAdmission)
  const active = runs.filter(run => run.id !== current?.id && !terminal.has(run.status))
  const occupied = active.map(run => normalize(run.voiceTaskAdmission))
  const claims = [candidate, ...occupied].filter(Boolean)
  if (!claims.length) return null // Preserve ordinary chat concurrency.
  const capacity = Math.min(...claims.map(claim => claim.maxConcurrency))
  const conflicts = active.length && (!candidate?.resourceKey || occupied.some(claim => !claim?.resourceKey || claim.resourceKey === candidate.resourceKey))
  if (active.length >= capacity || conflicts) throw Object.assign(new Error('run_capacity'), { code: 'run_capacity' })
  return candidate
}
