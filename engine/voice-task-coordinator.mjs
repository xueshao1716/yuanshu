import { createVoiceTaskStore, validateSubmission, terminal, fail, copy } from './voice-task-store.mjs'
import { reconcileTask, hasCapacity, deliverTask, admissionForTask } from './voice-task-scheduler.mjs'

// Journal transactions never await external I/O. In-process per-task claims span
// adapters; independent task work, submit, list and stop remain available.
export function createVoiceTaskCoordinator({ rootDir, manager, createSession, canAccess, deliver, readResult, policy = {} }) {
  if (!rootDir || !manager || ![createSession, canAccess, deliver, readResult].every(fn => typeof fn === 'function')) throw fail('invalid_coordinator_options')
  const store = createVoiceTaskStore(rootDir), all = state => state.groups.flatMap(group => group.tasks)
  const needsWork = task => !terminal.has(task.status) || !['delivered', 'blocked'].includes(task.delivery?.status)
  const access = (origin, action, task) => {
    const allowed = canAccess(origin, action, task && copy(task))
    if (allowed?.then) { void Promise.resolve(allowed).catch(() => {}); throw fail('async_origin_authorization') }
    if (allowed !== true) throw fail('conversation_gone')
  }
  const reconcile = state => {
    let recoveryRuns
    for (const task of all(state).filter(needsWork)) {
      const run = task.runId ? manager.get(task.runId) : null
      if (run) reconcileTask(task, [run])
      else if (task.launchAttempted) {
        // Full history is only needed to recover an uncertain launch, not to
        // poll known runs. Capacity/admission checks remain authoritative.
        recoveryRuns ??= manager.list(); reconcileTask(task, recoveryRuns)
      }
    }
  }
  const change = (id, fn) => store.transaction(state => {
    reconcile(state); const task = all(state).find(item => item.id === id)
    if (!task) throw fail('task_not_found')
    return fn(task, state)
  })
  const prepare = id => change(id, (task, state) => {
    if (task.status !== 'queued' || task.runId) return null
    const group = state.groups.find(item => item.id === task.groupId), deps = task.dependsOn.map(index => group.tasks[index])
    if (deps.some(dep => terminal.has(dep.status) && dep.status !== 'completed')) { task.status = 'blocked'; task.reason = 'dependency_failed'; return null }
    return deps.every(dep => dep.status === 'completed') && hasCapacity(task, all(state), manager.list(), policy) ? task : null
  })
  const launch = id => store.claim('launch', id, async () => {
    let task = await prepare(id)
    if (!task) return
    try {
      access(task.conversationId, 'execute', task)
      if (!task.sessionReady) {
        const session = await createSession(copy(task))
        if ((typeof session === 'string' ? session : session?.id) !== task.sessionId) throw fail('session_id_mismatch')
        task = await change(id, current => { current.sessionReady = true; return current })
      }
      const defaults = typeof policy.runBody === 'function' ? await policy.runBody(copy(task)) : policy.runBody
      const supplied = typeof policy.context === 'function' ? await policy.context(copy(task)) : policy.context
      const context = { headers: supplied?.headers || {}, socket: { ...supplied?.socket, remoteAddress: supplied?.socket?.remoteAddress || '0.0.0.0' } }
      access(task.conversationId, 'execute', task)
      await change(id, (current, state) => {
        access(current.conversationId, 'execute', current)
        // No await between final capacity check and manager admission. The manager
        // must enforce this admission against later non-coordinator creates too.
        if (current.status !== 'queued' || current.runId || !hasCapacity(current, all(state), manager.list(), policy)) return
        if (policy.validateSession && policy.validateSession(copy(current)) !== true) throw fail('session_owner_mismatch')
        context.voiceTaskAdmission = admissionForTask(current, policy)
        current.launchAttempted = true; store.save(state)
        try {
          const run = manager.create({ ...defaults, model: policy.model ?? defaults?.model, sessionId: current.sessionId, clientRequestId: current.id, message: current.instruction, stream: true, backgroundRecovery: false }, context)
          if (run?.then) throw fail('async_run_manager_unsupported')
          current.runId = run.id; current.status = run.status
        } catch (error) {
          if (error.code === 'run_capacity') { current.launchAttempted = false; return }
          const existing = reconcileTask(current, manager.list())
          if (!existing) { current.status = 'interrupted'; current.reason = error.code || 'execution_uncertain' }
        }
      })
    } catch (error) {
      await change(id, current => {
        if (!terminal.has(current.status) && !current.runId) { current.status = current.launchAttempted ? 'interrupted' : 'blocked'; current.reason = error.code || 'session_setup_failed' }
      })
    }
  })
  const deliverOne = id => store.claim('delivery', id, async () => {
    const task = await change(id, current => current), run = task.runId ? manager.get(task.runId) : null
    const save = () => change(id, current => { current.delivery = copy(task.delivery) })
    await deliverTask(task, run, { canAccess, readResult, deliver, save })
  })
  return {
    async submit(input) {
      const tasks = validateSubmission(input); access(input.conversationId, 'submit')
      return store.transaction(state => { access(input.conversationId, 'submit'); reconcile(state); return store.submit(state, input, tasks) })
    },
    async list(conversationId) {
      access(conversationId, 'list')
      return store.transaction(state => { access(conversationId, 'list'); reconcile(state); return all(state).filter(task => task.conversationId === conversationId) })
    },
    async tick() {
      // Most polls are idle. Inspect the journal under its lock without scanning
      // every historical run or writing an unchanged journal on the event loop.
      const snapshot = await store.exclusive(() => all(store.read()))
      if (!snapshot.some(needsWork)) return snapshot
      const tasks = await store.transaction(state => { reconcile(state); return all(state) })
      // Claims singleflight each task across instances without holding unrelated
      // scheduling hostage to one slow session/result/delivery adapter.
      await Promise.all(tasks.filter(needsWork).map(async task => { await launch(task.id); await deliverOne(task.id) }))
      return store.transaction(state => { reconcile(state); return all(state) })
    },
    async stop(conversationId, taskId) {
      access(conversationId, 'stop')
      return change(taskId, task => {
        access(conversationId, 'stop', task)
        if (task.conversationId !== conversationId) throw fail('task_not_found')
        if (!terminal.has(task.status)) {
          if (task.runId) { const run = manager.stop(task.runId); task.status = run.status }
          else { task.status = 'stopped'; task.reason = 'user_stop' }
        }
        return task
      })
    },
  }
}
