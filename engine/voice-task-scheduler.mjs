import { terminal, copy, fail } from './voice-task-store.mjs'
export function reconcileTask(task, runs) {
  const run = runs.find(run => run.id === task.runId || (run.sessionId === task.sessionId && run.clientRequestId === task.id))
  if (run) { task.runId = run.id; task.status = run.status }
  else if (task.launchAttempted && !terminal.has(task.status)) { task.status = 'interrupted'; task.reason = 'execution_uncertain' }
  return run
}
export function admissionForTask(task, policy) {
  const result = policy.resourceForTask?.(copy(task))
  return { resourceKey: typeof result === 'string' && result.trim() ? result : null, maxConcurrency: Math.max(1, Math.min(8, Number.isInteger(policy.maxConcurrency) ? policy.maxConcurrency : 1)) }
}
export function hasCapacity(task, allTasks, runs, policy) {
  const active = runs.filter(run => !terminal.has(run.status))
  const max = admissionForTask(task, policy).maxConcurrency
  if (active.length >= max) return false
  const resource = value => {
    const result = policy.resourceForTask?.(copy(value))
    return typeof result === 'string' && result.trim() ? result : null
  }
  const candidate = resource(task)
  return active.every(run => {
    const owner = allTasks.find(item => item.runId === run.id)
    const occupied = owner && resource(owner)
    return candidate && occupied && candidate !== occupied
  })
}
export async function deliverTask(task, run, { canAccess, readResult, deliver, save }) {
  if (!terminal.has(task.status) || ['delivered', 'blocked'].includes(task.delivery?.status)) return
  const deliveryId = task.delivery?.id || `voice-result-${task.id}-r${task.requirementRevision || 1}-v1`
  if (!(await canAccess(task.conversationId, 'deliver', copy(task)))) {
    task.delivery = { ...task.delivery, id: deliveryId, status: 'blocked', code: 'conversation_gone' }; await save(); return
  }
  try {
    if (!task.delivery) {
      const result = run ? await readResult(copy(run), copy(task)) : { status: task.status, summary: task.reason || task.status }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail('invalid_task_result')
      task.delivery = { id: deliveryId, status: 'pending', result, attempts: 0 }; await save()
    }
    if (!(await canAccess(task.conversationId, 'deliver', copy(task)))) throw fail('conversation_gone')
    task.delivery.attempts++; await save()
    const receipt = await deliver(copy(task), copy(task.delivery.result), task.delivery.id)
    if (receipt?.code === 'conversation_gone') { task.delivery.status = 'blocked'; task.delivery.code = receipt.code }
    else {
      if (typeof receipt?.messageId !== 'string' || !receipt.messageId) throw fail('invalid_delivery_receipt')
      if (receipt.result) task.delivery.result = receipt.result
      task.delivery.status = 'delivered'; task.delivery.messageId = receipt.messageId; delete task.delivery.error
    }
  } catch (error) {
    if (task.delivery) { task.delivery.error = String(error?.message || error).slice(0, 500); if (error?.code === 'conversation_gone') { task.delivery.status = 'blocked'; task.delivery.code = error.code } }
  }
  await save()
}
