import { api } from '../api'

export type Acceptance = 'pending' | 'pass' | 'fail' | 'revoke' | 'stale' | 'invalid'
export type Verdict = 'pass' | 'fail' | 'revoke'
export interface EvidenceItem {
  runId: string; input: string; at: string; status: string; acceptance: Acceptance; lane: 'task' | 'team'
}
export interface EvidenceDetail extends EvidenceItem {
  sessionId: string; digest: string; text: string; skills: string[]; issues: string[]; reviewable: boolean; eligible: boolean
  artifacts: { path: string; size: number | null; digest: string | null; error: string | null }[]
  review: { revision: string; verdict: Verdict; at: string; note: string; skills: string[] } | null
  evolutionError?: string
  subagents?: { id: string; role: string; model: string; status: string; summary: string }[]
}
export interface EvidenceList { items: EvidenceItem[]; total: number; limit: number; retainedReviews: number; reviewLimit: number
  summary: { pass: number; fail: number; revoke: number; stale: number; invalid: number; eligible: number; coverage: Record<string, number> } }
export interface EvolutionProgress {
  observed: number; qualified: number; groups: number; phase: string; reason: string; candidate: string | null
  discovery: { count: number; required: number }; holdout: { count: number; required: number }
  future: { count: number; required: number }; canary: { count: number; required: number }
  enabled: boolean; expiresAt: string | null; checkedAt: string | null; note: string
}
export interface EvidenceStatus {
  evolution: { progress: EvolutionProgress; team: { observed: number; accepted: number }
    explore: { phase: string; reason: string } | null }
}
export const acceptanceLabels: Record<Acceptance, string> = {
  pending: '待验收', pass: '合格', fail: '有问题', revoke: '已撤销', stale: '旧验收已失效', invalid: '验收记录异常',
}
export const TaskEvidenceApi = {
  list: () => api<EvidenceList>('/api/dream/evidence'),
  status: () => api<EvidenceStatus>('/api/dream/status'),
  evaluate: () => api('/api/dream/run', { method: 'POST', timeoutMs: 60000 }),
  get: (id: string) => api<EvidenceDetail>(`/api/dream/evidence/${encodeURIComponent(id)}`),
  review: (row: EvidenceDetail, verdict: Verdict, note: string, skills: string[]) => api<EvidenceDetail>(`/api/dream/evidence/${encodeURIComponent(row.runId)}`, {
    method: 'POST', body: { digest: row.digest, revision: row.review?.revision || null, verdict, note, skills }, timeoutMs: 60000,
  }),
}
