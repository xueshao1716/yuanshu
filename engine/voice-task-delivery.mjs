import fs from 'node:fs'
import path from 'node:path'
import { voiceTaskResultText } from './voice-task-result.mjs'
import { validateVoiceTaskSession } from './session-origin-auth.mjs'
const NL = String.fromCharCode(10)
const entries = sm => sm.fileEntries || sm.getFileEntries()

export function ensureVoiceTaskSession(task, { sessionsDir, cwd, invalidate = () => {} }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(task.sessionId)) throw new Error('invalid_session_id')
  if (!task.id || !task.conversationId || task.sessionId === task.conversationId) throw new Error('invalid_task_session')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const file = path.join(sessionsDir, task.sessionId + '.jsonl')
  const timestamp = new Date().toISOString()
  const rows = [
    { type: 'session', version: 3, id: task.sessionId, cwd, timestamp },
    { type: 'session_info', id: 'voice-info', parentId: null, timestamp, name: '通话任务 · ' + task.title },
    { type: 'custom', customType: 'voice-task-origin', id: 'voice-origin', parentId: 'voice-info', timestamp, data: { taskId: task.id, conversationId: task.conversationId } },
  ]
  try { fs.writeFileSync(file, rows.map(JSON.stringify).join(NL) + NL, { flag: 'wx' }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!validateVoiceTaskSession(task, { sessionsDir, cwd })) throw new Error('session_owner_mismatch')
  }
  invalidate(); return task.sessionId
}

export function createVoiceTaskDelivery({ withSession, notify = () => {}, refreshResult }) {
  return (task, result, deliveryId) => {
    if (!deliveryId || !task.conversationId) throw new Error('invalid_delivery')
    const receipt = withSession(task.conversationId, sm => {
      const rows = entries(sm)
      const saved = rows.find(row => row.customType === 'voice-task-delivery' && row.data?.deliveryId === deliveryId)
      if (saved?.data?.messageId) return { messageId: saved.data.messageId, ...(saved.data.result ? { result: saved.data.result } : {}) }
      const previous = rows.find(row => row.message?.voiceDeliveryId === deliveryId)
      let messageId = previous?.id
      let deliveredResult = previous?.message?.voiceTaskResult
      if (!messageId) {
        // Recheck files only when actually appending, after the busy-origin gate.
        // Existing messages/receipts retain their original evidence on retries.
        if (refreshResult) {
          result = refreshResult(task, result)
          if (!result || typeof result !== 'object' || result.then || Array.isArray(result)) throw new Error('invalid_task_result')
          deliveredResult = result
        }
        const text = voiceTaskResultText(task, result)
        const entry = sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now(), stopReason: 'stop',
          voiceDeliveryId: deliveryId, voiceTaskId: task.id, voiceRunId: task.runId, engine: 'yuanshu',
          ...(deliveredResult ? { voiceTaskResult: deliveredResult } : {}),
          ...(result.model ? { model: result.model } : {}) })
        messageId = typeof entry === 'string' ? entry : entry?.id
      }
      if (!messageId) throw new Error('delivery_message_not_persisted')
      const evidence = deliveredResult ? { result: deliveredResult } : {}
      sm.appendCustomEntry('voice-task-delivery', { deliveryId, messageId, taskId: task.id, runId: task.runId, ...evidence })
      return { messageId, ...evidence }
    })
    if (receipt?.messageId) { try { notify(task.conversationId, receipt) } catch {} }
    return receipt
  }
}
