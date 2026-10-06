import { api } from '../api'
export type Definition = Record<string, string | number | string[] | null>
export type Revision = { snapshot_id: string; created_at: string; action: string; changed: string[]; reviewer: string; previousRevision: string; appliedRevision: string; rolled_back_at?: string }
export type Persona = { definition: Definition; source: string; problems: string[]; revision: string | null; history: Revision[]; rendered: string }
export type Proposal = { proposal_id: string; gene: string; proposed_baseline: number; current_baseline: number; reason: string; evidence: unknown[]; status: string }
export type GeneSnapshot = { snapshot_id: string; gene: string; old_baseline: number; applied_baseline: number; rolled_back_at?: string }
export type Genome = { genes: Record<string, {baseline: number; expression: number; revision?: string}>; proposals: Proposal[]; snapshots: GeneSnapshot[]; reviews: {proposal_id: string; decision: string; reviewer: string; reason?: string}[] }
export type Confirmation = {id: string; sessionId: string; toolName: string; reason: string; expiresAt: number}
export type LastNight = { ran: boolean
  task: {id: string; lastRun: string | null; status: string | null; durationMs: number | null} | null
  entry: {at: string; title: string; execSummary: string; execRows: {status: string; closed: boolean; text: string}[]; lessons: string[]} | null
  commitments: {fresh: number; pending: number; fix: number; track: number; ask: number; stale: number}
  proposals: {lesson: number; lessonItems: string[]}
  dream: {fixTraces: number; skillEligible: number; skillObserved: number; hint: string} }
const post = async (path: string, body: unknown) => {
  const value = await api<any>(path, { method: 'POST', body, timeoutMs: 75000 })
  if (value.error || value.ok === false) throw new Error(value.error || '操作没有完成，请刷新后核对')
  return value
}
export const SoulApi = {
  persona: () => api<Persona>('/api/persona'),
  genome: () => api<Genome>('/api/genome'),
  apply: (body: unknown) => post('/api/persona/apply', body),
  rollback: (body: unknown) => post('/api/persona/rollback', body),
  gene: (action: string, body: unknown) => post(`/api/genome/${action}`, body),
  confirmations: (sid: string) => api<{items: Confirmation[]; canApprove: boolean}>(`/api/persona/confirmations?sessionId=${encodeURIComponent(sid)}`),
  lastNight: () => api<LastNight>('/api/soul/last-night'),
}
