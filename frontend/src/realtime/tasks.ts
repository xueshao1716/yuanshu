import { apiUrl, getToken } from '../api'
export type VoiceTask = { id: string; title: string; status: string; delivery?: { status: string } }
async function request(path: string, signal: AbortSignal, body?: object) {
  const url = new URL(apiUrl(path), location.href)
  if (url.origin !== location.origin) throw new Error('same_origin_required')
  const response = await fetch(url, { method: body ? 'POST' : 'GET', signal, cache: 'no-store', credentials: 'omit',
    headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  if (!response.ok) throw new Error(response.status === 401 ? 'unauthorized' : response.status === 404 ? 'conversation_gone' : 'task_unavailable')
  return response.json()
}
export async function listVoiceTasks(id: string, signal: AbortSignal): Promise<VoiceTask[]> {
  const data = await request('/api/voice/tasks?conversationId=' + encodeURIComponent(id), signal)
  if (!Array.isArray(data.tasks)) throw new Error('task_unavailable')
  return data.tasks
}
export const stopVoiceTask = (conversationId: string, taskId: string, signal: AbortSignal) =>
  request('/api/voice/tasks/' + encodeURIComponent(taskId) + '/stop', signal, { conversationId })
