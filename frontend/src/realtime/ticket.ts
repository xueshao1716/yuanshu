import { apiUrl, getToken, webSocketUrl } from '../api'

export const callSocketUrl = () => webSocketUrl('/ws/chat-voice')
export async function requestCallTicket(conversationId: string, signal: AbortSignal, modelKey?: string) {
  const url = new URL(apiUrl('/api/voice/ticket'), location.href)
  if (url.origin !== location.origin) throw new Error('same_origin_required')
  const response = await fetch(url, { method: 'POST', signal, cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ conversationId, modelKey }) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'connection_failed')
  if (typeof data.ticket !== 'string') throw new Error('connection_failed')
  return { ticket: data.ticket }
}

export type VoiceModel = { modelKey: string; id: string; provider: string; name: string }
export async function requestVoiceModels(signal: AbortSignal): Promise<VoiceModel[]> {
  const url = new URL(apiUrl('/api/voice/models'), location.href)
  if (url.origin !== location.origin) throw new Error('same_origin_required')
  const response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit', headers: { Authorization: `Bearer ${getToken()}` } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'connection_failed')
  if (!Array.isArray(data.models) || data.models.some(m => !m || ['modelKey', 'id', 'provider', 'name'].some(k => typeof m[k] !== 'string'))) throw new Error('connection_failed')
  return data.models
}
