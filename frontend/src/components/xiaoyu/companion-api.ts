import { api } from '../../api'
import type { CompanionFacts, CompanionDecision } from './companion-state.mjs'
export type Trigger = 'auto' | 'tap' | 'text' | 'busy' | 'rest'
export const CompanionApi = {
  facts: (sessionId: string) => api<CompanionFacts>(`/api/companion/facts?sessionId=${encodeURIComponent(sessionId)}`),
  preferences: () => api<{ dnd: boolean }>('/api/companion/preferences'),
  setDnd: (dnd: boolean) => api<{ dnd: boolean }>('/api/companion/preferences', { method: 'POST', body: { dnd } }),
  decide: (body: { sessionId: string; contextEpoch: string; interactionId: string; trigger: Trigger; text: string; visible: boolean }, signal: AbortSignal) =>
    api<{ status: string; decision?: CompanionDecision }>('/api/companion/decision', { method: 'POST', body, signal }),
}
