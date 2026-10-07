import { api } from '../api'

export const knowledgePolling = { refreshInterval: 30000, refreshWhenHidden: false }
export type KnowledgeRate = { input: number; output: number; currency: string; free?: boolean; tokenBound?: string }
export type KnowledgeMethodData = {
  checker: string; artifactPath: string; artifactHash: string; manifestHash: string
  assertions: Array<{ pointer: string; equals: string | number | boolean | null }>
  environment: { workspace: string; platform: string; nodeMajor: string; runId: string; sessionId: string }
}
export type KnowledgePolicyData = {
  revision: number; localEnabled: boolean; paused: boolean; remoteEnabled: boolean; networkEnabled: boolean
  dailyCost: number; currency: string; maxModelRequests: number; maxNetworkRequests: number
  inputTokens: number; outputTokens: number; allowedRoots: string[]; allowedUrls: string[]
  allowedModels: string[]; outboundRoots: string[]; model: string; rates: Record<string, KnowledgeRate>
}
export type KnowledgeJob = {
  id: string; title: string; state: string; displayState?: string; stage: string; revision: number; reason?: string; event?: string
  cultivationProvenance?: {role:string;agentId:string;designId:string;runId:string;outputHash:string;lineage:string[]}
  nextAttemptAt?: number; createdAt: number; entryId?: string; relatedJobId?: string; replacementJobId?: string
  provenance?: KnowledgeProvenanceData
  resolution?: { jobId: string; entryId: string; at: number }
  candidate?: { text?: string }
  reviews?: Array<{ decision: string; note: string; at: number; source: string }>
  reviewOptions?: Array<{ id: string; text: string; sources: Array<{ locator: string }> }>
  sources: Array<{ kind: string; path?: string; url?: string; runId?: string; sessionId?: string; hash?: string }>
  validation?: { reason?: string; conflicts?: string[]; entry?: { text: string; verified: boolean; scope: string; method?: KnowledgeMethodData } }
}
export type KnowledgeProvenanceData = {
  status: 'available' | 'unavailable' | 'not_applicable'; methodVerified: false
  task: null | { runId: string; sessionId: string; status: string; objective: string; acceptance: string; reviewRevision: number | null }
  teams: Array<{ runId: string; parentRunId: string; sessionId: string; modelReview: string; acceptance: string }>
}
export type KnowledgeStatus = {
  summary: { counts: Record<string, number>; total: number; policyRevision: number; paused: boolean }
  budget: { day: string; currency: string; spent: number; reserved: number; unknown: number; modelRequests: number; networkRequests: number }
  worker: { running: boolean; cooldownUntil: number; lastError?: string }; lastError?: string
  intake?: { lastError?: string | null }
}
const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body })
export const KnowledgeApi = {
  status: () => api<KnowledgeStatus>('/api/knowledge/status'),
  policy: () => api<KnowledgePolicyData>('/api/knowledge/policy'),
  models: () => api<Array<{ key: string; label: string; reasoning?: boolean; cost?: { input: number; output: number } }>>('/api/knowledge/models'),
  jobs: (offset: number) => api<{ items: KnowledgeJob[]; total: number }>(`/api/knowledge/jobs?offset=${offset}&limit=20`),
  job: (id: string) => api<KnowledgeJob>(`/api/knowledge/jobs/${encodeURIComponent(id)}`),
  updatePolicy: (patch: Partial<KnowledgePolicyData>, revision: number) => post<KnowledgePolicyData>('/api/knowledge/policy', { patch, revision }),
  control: (id: string, action: string, revision: number) => post<KnowledgeJob>(`/api/knowledge/jobs/${encodeURIComponent(id)}/control`, { action, revision }),
  enqueue: (source: Record<string, string>, revision: number) => post<KnowledgeJob>('/api/knowledge/enqueue', { source, revision }),
  supplement: (id: string, source: Record<string, string>, revision: number, policyRevision: number) => post<KnowledgeJob>(`/api/knowledge/jobs/${encodeURIComponent(id)}/supplement`, { source, revision, policyRevision }),
  review: (id: string, decision: { decision: string; note: string; confirmed: boolean; selectedEntryId?: string }, revision: number, policyRevision: number) => post<KnowledgeJob>(`/api/knowledge/jobs/${encodeURIComponent(id)}/review`, { ...decision, revision, policyRevision }),
}
const reasons: Record<string, string> = {
  job_resolved: '原任务已由补证解决，请查看关联的补证记录；不能重复裁决或补证。',
  knowledge_storage_full: '知识队列已达到容量上限，新资料尚未登记。请先处理或归档记录；原始任务不会被删除。',
  intake_unavailable: '资料登记暂时失败，原始任务仍保留，后台会再次核对。',
  input_limit: '当前输入额度不足以容纳必要片段和来源标记，请调整额度后重试。',
  invalid_review: '请填写核对理由并明确确认本次裁决。', review_not_eligible: '证据仍不满足要求，不能通过人工选择绕过。',
  human_reviewed_source: '已记录人工来源选择，等待后台重核后写入。', human_rejected: '人工选择不采用；原始证据和记录保留。',
  existing_source_selected: '人工选择保留现有来源；冲突记录仍保留。',
  review_parent_changed: '原任务在裁决后发生变化，本次补证已停止提交，请重新核对。',
  method_manifest_invalid: '验证清单格式或检查器不支持；目前仅允许 json-contract-v1 固定字段契约。',
  method_artifact_unbound: '未找到这次已完成任务实际交付的对应产物，不能验证方法。',
  method_check_failed: '真实产物未通过所列字段契约，方法仍未验证。',
  revision_conflict: '记录已在其他页面更新。请刷新后核对，再提交。',
  source_not_authorized: '来源尚未授权，请核对允许读取的目录。', network_disabled: '网页采集尚未开启。',
  url_not_authorized: '该网页不在授权列表中，请填写完整 HTTPS 地址。', outbound_denied: '资料不在允许发送给模型的目录中。',
  budget_exhausted: '今日预算已用完，等待下个额度周期或调整预算。', request_limit: '今日请求次数已达上限。',
  price_unknown: '缺少模型价格，不能估算并预留费用。', token_bound_unknown: '尚未确认模型的安全用量上限。',
  source_changed: '原始来源已变化，需要重新提交当前版本。', invalid_policy: '设置格式不正确，请核对额度、目录和价格。',
  model_not_authorized: '模型不可用或未授权，请重新选择。', excerpt_mismatch: '摘录与原文不一致，未写入知识库。',
  untrusted_instructions: '来源包含疑似指令，已隔离等待核查。', source_conflict: '来源存在冲突，需先核对证据。',
  independent_evidence_required: '模型结论缺少独立证据，不能自动当作事实。', attributed_excerpt: '原文摘录已核对；不是独立事实验证。',
  knowledge_unavailable: '知识服务暂不可用，请稍后刷新。聊天不受此限制。', invalid_control: '当前状态不支持该操作，请刷新。',
  correction_requires_review: '补充证据已关联原任务，仍需核查，不会自动批准原结论。',
  source_missing: '暂未找到可读的获准来源。可补充文件，或核对资料授权。',
  source_replaced: '已找到获准资料，由关联的新任务继续处理；本条保留历史。',
  no_authorized_sources: '当时没有授权任何资料目录或网址，已收起；授权后会自动重新查找。',
  source_format_unsupported: '表格、压缩包等二进制文件不进知识库，已收起；原文件仍在原处，需要时直接让小语读文件。',
  source_path_denied: '该路径不可作为来源，请选择工作空间内的普通资料文件。',
  currency_mismatch: '价格币种与预算币种不一致，请核对价格；系统不会自动换算。',
}
export const knowledgeReason = (code?: string) => code ? reasons[code] || `尚未完成（${code}），请核对来源或稍后重试。` : ''
export const knowledgeError = (error: unknown) => knowledgeReason(error instanceof Error ? error.message : 'knowledge_unavailable')
