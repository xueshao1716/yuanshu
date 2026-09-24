import path from 'node:path'
import { hashArgs } from './run-effects.mjs'

const MAX_RESUMES = 3
const WINDOW_MS = 2 * 60 * 60_000
export const RUN_SLICE_MS = 30 * 60_000
export const scopeKey = value => value ? (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)) : null

export function newRecoveryPolicy(scope, enabled = true, now = Date.now()) {
  return { enabled, used: 0, maxResumes: MAX_RESUMES, deadlineAt: new Date(now + WINDOW_MS).toISOString(),
    scope: scopeKey(scope), state: enabled ? 'ready' : 'disabled', reason: enabled ? null : 'disabled' }
}

export function publicRecovery(policy) {
  if (!policy) return null
  const { scope, ...visible } = policy
  return visible
}

function safeSnapshot(checkpoint) {
  const snapshot = checkpoint?.historySnapshot
  if (checkpoint?.checkpointKind !== 'tool_results' || snapshot?.v !== 1 || !Array.isArray(snapshot.messages) || !snapshot.messages.length) return false
  if (!snapshot.digest || snapshot.digest !== hashArgs(snapshot.messages)) return false
  if (checkpoint.historyDigest && checkpoint.historyDigest !== snapshot.digest) return false
  if (checkpoint.pendingSteps?.length || checkpoint.uncertainSteps?.length) return false
  if (checkpoint.toolPlan?.some(step => step.status !== 'completed')) return false
  const calls = snapshot.messages.flatMap(m => m?.tool_calls || []).map(call => call.id)
  const results = snapshot.messages.filter(m => m?.role === 'tool').map(m => m.tool_call_id)
  return snapshot.messages.some(m => m?.role === 'user') && calls.every(id => results.includes(id)) && results.every(id => calls.includes(id))
}

export function recoveryBlockReason(run, { effects, scope, reserved = false, now = Date.now() }) {
  const policy = run?.backgroundRecovery
  if (!policy?.enabled) return 'disabled'
  if (run.stopRequestedAt || ['stopped', 'stopping'].includes(run.status)) return 'user_stop'
  if (run.approvalRequired) return 'approval_required'
  if (!scopeKey(scope) || policy.scope !== scopeKey(scope)) return 'scope_changed'
  if (run.checkpoint?.team || run.request?.workflow) return 'team_requires_review'
  if (!Number.isFinite(Date.parse(policy.deadlineAt)) || Date.parse(policy.deadlineAt) <= now) return 'deadline_reached'
  if (!Number.isInteger(policy.used) || policy.used < 0 || policy.used > MAX_RESUMES || (!reserved && policy.used >= MAX_RESUMES)) return 'limit_reached'
  if (!safeSnapshot(run.checkpoint) || !run.request?.message) return 'checkpoint_invalid'
  let journal
  try { journal = effects?.inspect?.(run.id) } catch {}
  if (!journal?.ok) return 'effects_unavailable'
  if (journal.steps.some(step => step?.state !== 'completed')) return 'effects_uncertain'
  const complete = new Set(journal.steps.map(step => step.key))
  if (run.checkpoint.completedSteps?.some(key => !complete.has(key))) return 'effects_unavailable'
  return null
}

export function createBackgroundRecovery({ store, effects, workspaceScope, instanceId, append, resume, scheduleRecovery }) {
  const timers = new Map()
  const schedule = scheduleRecovery || (callback => { const timer = setTimeout(callback, 1000); timer.unref?.(); return () => clearTimeout(timer) })
  const cancel = id => { timers.get(id)?.(); timers.delete(id) }
  const blocked = (run, reason, publish = false) => {
    const updated = store.update(run.id, { ...(publish ? { status: 'interrupted', resumeAvailable: true, pauseReason: 'recovery_blocked', error: null } : {}),
      backgroundRecovery: { ...run.backgroundRecovery, state: 'blocked', reason } })
    if (publish) append(updated, 'interrupted', { reason: 'recovery_blocked', recoveryReason: reason, message: '自动接续已暂停，请检查运行状态后手动继续。' })
    return updated
  }
  return {
    cancel,
    dispose() { for (const id of timers.keys()) cancel(id) },
    trySchedule(run, cause) {
      if (!run.backgroundRecovery || !['execution_budget', 'server_restarted'].includes(cause)) return false
      const reserved = run.backgroundRecovery.state === 'scheduled'
      const reason = recoveryBlockReason(run, { effects, scope: workspaceScope(), reserved })
      if (reason) { blocked(run, reason); return false }
      cancel(run.id)
      const updated = store.update(run.id, { status: 'queued', ownerId: instanceId, resumeAvailable: false, error: null, pauseReason: null, pauseMessage: null,
        backgroundRecovery: { ...run.backgroundRecovery, used: run.backgroundRecovery.used + (reserved ? 0 : 1), state: 'scheduled', reason: cause } })
      append(updated, 'recovery_scheduled', { message: '检查点已保存，后台即将自动接续；关闭页面不影响任务。', used: updated.backgroundRecovery.used, maxResumes: MAX_RESUMES })
      timers.set(run.id, schedule(() => {
        timers.delete(run.id)
        const current = store.get(run.id)
        if (current?.status !== 'queued' || current.backgroundRecovery?.state !== 'scheduled' || current.ownerId !== instanceId) return
        const reason = recoveryBlockReason(current, { effects, scope: workspaceScope(), reserved: true })
        const other = store.list().some(r => r.id !== current.id && r.sessionId === current.sessionId && ['queued', 'running', 'stopping'].includes(r.status))
        if (reason || other) { blocked(current, reason || 'session_busy', true); return }
        store.update(current.id, { status: 'interrupted', resumeAvailable: true, backgroundRecovery: { ...current.backgroundRecovery, state: 'running', reason: null } })
        try { resume(current.id) } catch { blocked(store.get(current.id), 'resume_failed', true) }
      }))
      return true
    },
    disable(id) {
      const run = store.get(id)
      if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' })
      cancel(id)
      if (!run.backgroundRecovery) return run
      const updated = store.update(id, { backgroundRecovery: { ...run.backgroundRecovery, enabled: false, state: 'disabled', reason: 'disabled' } })
      return run.status === 'queued' && run.backgroundRecovery.state === 'scheduled' ? blocked(updated, 'disabled', true) : updated
    },
  }
}
