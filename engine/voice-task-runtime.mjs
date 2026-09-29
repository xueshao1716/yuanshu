import { createVoiceTaskCoordinator } from './voice-task-coordinator.mjs'
import { ensureVoiceTaskSession, createVoiceTaskDelivery } from './voice-task-delivery.mjs'
import { readVoiceTaskResult } from './voice-task-result.mjs'
import { fail } from './voice-task-store.mjs'
import { validateVoiceTaskSession } from './session-origin-auth.mjs'

// Constructing the adapter is inert. Start only after run-manager recovery and
// approval initialization. Closing the adapter never cancels accepted runs.
export function createVoiceTaskRuntime({ rootDir, manager, sessionsDir, cwd, canAccess, withSession, taskEvidence, getModel,
  invalidate, notify, intervalMs = 1000, onError = () => {} }) {
  if (![canAccess, withSession, getModel].every(fn => typeof fn === 'function') || typeof taskEvidence?.get !== 'function') throw fail('invalid_runtime_options')
  const readResult = (run, task) => readVoiceTaskResult(taskEvidence, run, task)
  const coordinator = createVoiceTaskCoordinator({ rootDir, manager, canAccess,
    createSession: task => ensureVoiceTaskSession(task, { sessionsDir, cwd, invalidate }),
    deliver: createVoiceTaskDelivery({ withSession, notify, refreshResult: (task, result) => task.runId ? readResult(manager.get(task.runId), task) : result }), readResult,
    // There is no enforced project/tool sandbox yet: unknown resource scope is
    // globally exclusive. Browser headers, secrets and localhost approval cannot
    // become execution authority, including after recovery.
    policy: { maxConcurrency: 1, context: { headers: {}, socket: { remoteAddress: '0.0.0.0' } },
      validateSession: task => validateVoiceTaskSession(task, { sessionsDir, cwd }),
      runBody: () => {
        const selected = getModel()
        const model = typeof selected === 'string' ? selected :
          typeof selected?.provider === 'string' && selected.provider.trim() && typeof selected?.id === 'string' && selected.id.trim() ? `${selected.provider}/${selected.id}` : null
        if (!model?.trim()) throw fail('task_model_unavailable')
        return { model }
      } },
  })
  let timer = null, inFlight = null
  const tick = () => {
    if (inFlight) return inFlight
    inFlight = coordinator.tick().finally(() => { inFlight = null })
    return inFlight
  }
  const poll = () => { void tick().catch(() => { try { onError({ code: 'voice_recovery_failed' }) } catch {} }) }
  return { submit: coordinator.submit, list: coordinator.list, stop: coordinator.stop, tick,
    start() {
      if (timer) return
      timer = setInterval(poll, Math.max(10, Number.isFinite(intervalMs) ? intervalMs : 1000)); timer.unref?.(); poll()
    },
    close() { if (timer) clearInterval(timer); timer = null },
  }
}
