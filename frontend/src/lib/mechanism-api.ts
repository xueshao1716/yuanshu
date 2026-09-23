import { api } from '../api'

export interface MechanismCase {
  id: string; label: string; kind: string; beforeCount: number; afterCount: number
  passed: boolean; inputUnchanged: boolean; messagesPreserved: boolean; error: string | null
}
export interface MechanismStatus {
  definition: { title: string; observation: string; evidence: string; problem: string; hypothesis: string
    intervention: string; expectation: string; falsification: string; scope: string }
  state: 'untested' | 'supported' | 'not-supported' | 'stale' | 'invalid' | 'error'
  running: boolean
  latest: { id: string; at: string; sourceVersion: string; sourceFingerprint: string; error: string | null; cases: MechanismCase[] } | null
  recentRuns: { id: string; at: string }[]
  governance: string
}
export const MechanismApi = {
  status: () => api<MechanismStatus>('/api/dream/experiment'),
  run: () => api<MechanismStatus>('/api/dream/experiment', { method: 'POST', timeoutMs: 25000 }),
}
