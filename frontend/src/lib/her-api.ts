// 「她的状态」只读接口（2026-11-10）
// 动机：过去两天把关系 / 成长 / 正向账本 / 教训复习 / 反模式 / 机制体检 / 退化自评 /
// 定时任务审计 / 自证准入 / 旁路留痕都做进了后台，但前端一个入口都没有。
// 这里只做两件事：① 按后台真实返回形状收类型；② 把它们包成 SWR 能直接吃的取数函数。
// 纪律：全部 GET、全部只读——前端不提供任何写开关（写要人批准，不在这批 UI 里）。
import { api } from '../api'

// ── 关系（/api/relationship）──
export type RelationshipPayload = {
  ok?: boolean
  summary?: string
  stage?: { code?: string; name?: string }
  trust?: number
  intimacy?: number
  interactions?: number
  firstSeen?: string
  lastAt?: string
  notes?: string[]
}

// ── 正向账本（/api/praise-ledger）──
export type PraiseEntry = {
  id?: string
  kind?: string
  scene?: string
  what?: string
  why?: string
  evidence?: string
  weight?: number
  source?: string
  at?: number
}
export type PraiseLedgerPayload = {
  ok?: boolean
  total?: number
  updatedAt?: number
  stats?: {
    positive?: number
    negative?: number
    ratio?: number | null
    imbalanced?: boolean
    positiveWeight?: number
    negativeHits?: number
    negativeFailures?: number
    bySource?: Record<string, number>
    windowDays?: number
  }
  state?: { lastInjectedDate?: string; lastInjectedAt?: string; lastIds?: string[] }
  top?: PraiseEntry[]
  recent?: PraiseEntry[]
}

// ── 教训复习（/api/lesson-replay）──
export type LessonEntry = {
  id?: string
  text?: string
  topic?: string
  lastReplayed?: string
  replayCount?: number
  replayEscalated?: boolean
}
export type LessonReplayPayload = {
  ok?: boolean
  total?: number
  promoted?: number
  maxPerDay?: number
  state?: { lastInjectedDate?: string; lastInjectedAt?: string; lastIds?: string[]; lastTopics?: string[] }
  due?: LessonEntry[]
  recent?: LessonEntry[]
}

// ── 反模式台账（/api/anti-patterns）──
export type AntiPatternEntry = {
  id?: string
  title?: string
  severity?: string
  symptom?: string
  remedy?: string
  discoveredAt?: string
}
export type AntiPatternPayload = {
  ok?: boolean
  total?: number
  stats?: { total?: number; high?: number; medium?: number; low?: number }
  patterns?: AntiPatternEntry[]
}

// ── 机制新鲜度（/api/vitality）──
export type FreshnessState = 'fresh' | 'stale' | 'never' | 'unknown'
export type VitalityItem = {
  id?: string
  name?: string
  state?: FreshnessState
  label?: string
  lastAt?: number | null
  count?: number
  why?: string
}
export type VitalityPayload = {
  ok?: boolean
  at?: number
  line?: string
  counts?: { fresh?: number; stale?: number; never?: number; unknown?: number; total?: number }
  healthy?: boolean
  needsAttention?: number
  issues?: VitalityItem[]
  unknown?: VitalityItem[]
  flags?: { id?: string; name?: string; state?: FreshnessState; label?: string; note?: string }[]
  lastTick?: { at?: number; line?: string; needsAttention?: number } | null
}

// ── 定时任务审计（/api/scheduled/audit）──
export type ScheduledJobRow = {
  id?: string
  every?: string
  kind?: string
  reason?: string
  output?: string
  ok?: boolean
  note?: string
  planOk?: boolean
}
export type ScheduledAuditPayload = {
  ok?: boolean
  at?: number
  total?: number
  counts?: { deterministic?: number; needsJudgement?: number; violations?: number }
  deterministicJobs?: string[]
  needsJudgementJobs?: string[]
  violations?: { id?: string; kind?: string; reason?: string }[]
  jobs?: ScheduledJobRow[]
}

// ── 退化自评（/api/degradation）──
export type DegradationSubScore = {
  score?: number
  evaluated?: boolean
  evidence?: Record<string, unknown>
  note?: string
}
export type DegradationActiveAction = {
  scope?: string
  action?: string
  by?: string
  since?: number
  reason?: string
  autoReleasable?: boolean
}
export type DegradationPayload = {
  ok?: boolean
  at?: number
  assessment?: {
    score?: number
    meanScore?: number
    worstScore?: number
    level?: string
    levelFrom?: string
    subscores?: Record<string, DegradationSubScore>
    evaluated?: string[]
    unevaluated?: string[]
    reasons?: string[]
    scheduled?: { jobs?: number; silent?: unknown[]; alerts?: unknown[] }
  }
  gate?: { on?: boolean; reason?: string; by?: string; at?: number; action?: string; scopes?: Record<string, boolean> }
  activeActions?: DegradationActiveAction[]
  auto?: { risk?: string; humanOnly?: string[]; actionCooldownMs?: number }
  scheduled?: { jobs?: number; silent?: unknown[]; alerts?: unknown[] }
  thresholds?: { degraded?: number; critical?: number }
  ladder?: { action?: string; risk?: string; reversible?: boolean; level?: string; label?: string }[]
}

// ── 五维成长与世代（/api/genome/growth）──
// 注意：这一条的返回体没有 ok 字段（engine/genome-growth.mjs 的 status() 原样返回）。
export type GrowthPayload = {
  generation?: number
  dims?: Record<string, number>
  labels?: Record<string, string>
  measured?: Record<string, number> | null
  hasPending?: boolean
  pending?: {
    createdAt?: string
    reason?: string
    fromGeneration?: number
    toGeneration?: number
    dims?: Record<string, number>
    nextDims?: Record<string, number>
  } | null
  generations?: { gen?: number; at?: string; reason?: string; dims?: Record<string, number> }[]
  baseline?: { dims?: Record<string, number>; at?: string } | null
  evidence?: { turns?: number; guardBlocks?: number; guardWindowBlocks?: number }
  skipped?: string[]
}

// ── 自证 / 准入（/api/self-change/admissions）──
export type AdmissionEntry = {
  kind?: string
  at?: string
  ok?: boolean
  files?: string[]
  steps?: { name?: string; ok?: boolean; skipped?: boolean }[]
  reason?: string
  note?: string
  uncovered?: string[]
}
export type AdmissionsPayload = { ok?: boolean; items?: AdmissionEntry[] }

// ── 旁路留痕（/api/self-change/bypasses）──
export type BypassEntry = { at?: string; route?: string; files?: string[]; note?: string }
export type BypassesPayload = { ok?: boolean; items?: BypassEntry[]; total?: number }

export const HerApi = {
  relationship: () => api<RelationshipPayload>('/api/relationship'),
  praise: () => api<PraiseLedgerPayload>('/api/praise-ledger'),
  lessons: () => api<LessonReplayPayload>('/api/lesson-replay'),
  antiPatterns: () => api<AntiPatternPayload>('/api/anti-patterns?limit=20'),
  vitality: () => api<VitalityPayload>('/api/vitality'),
  scheduledAudit: () => api<ScheduledAuditPayload>('/api/scheduled/audit'),
  degradation: () => api<DegradationPayload>('/api/degradation'),
  growth: () => api<GrowthPayload>('/api/genome/growth'),
  admissions: () => api<AdmissionsPayload>('/api/self-change/admissions?limit=10'),
  bypasses: () => api<BypassesPayload>('/api/self-change/bypasses?limit=20'),
}

// ── 读数口径（都在这里收一次，七个面板用同一套，避免同一个数字两处说法不同）──

/** 五维固定顺序：后台 DIMS 就是这五个，缺一维时按顺序补齐，不按后端对象键序渲染。 */
export const GROWTH_DIMS = ['companion', 'understanding', 'judgment', 'responsibility', 'governance'] as const
export const GROWTH_DIM_FALLBACK: Record<string, string> = {
  companion: '陪伴',
  understanding: '理解',
  judgment: '判断',
  responsibility: '承担',
  governance: '治理',
}

/** 退化五维：键是后台的 subscores 键，值是给人看的中文名。 */
export const DEGRADATION_DIMS = ['competence', 'hallucination', 'contextPressure', 'modelStability', 'subagents'] as const
export const DEGRADATION_LABELS: Record<string, string> = {
  competence: '胜任（工具与交付）',
  hallucination: '可信（反模式命中）',
  contextPressure: '上下文压力',
  modelStability: '模型稳定',
  subagents: '子代理',
}

export const LEVEL_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  healthy: { label: '健康', tone: 'ok' },
  degraded: { label: '下滑', tone: 'warn' },
  critical: { label: '严重', tone: 'danger' },
}
export const levelMeta = (level?: string) =>
  LEVEL_META[String(level || '')] || { label: '未评估', tone: 'neutral' as const }

export const FRESH_META: Record<FreshnessState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  fresh: { label: '新鲜', tone: 'ok' },
  stale: { label: '停更', tone: 'warn' },
  never: { label: '从未产出', tone: 'danger' },
  unknown: { label: '无证据', tone: 'neutral' },
}
export const freshMeta = (state?: string) =>
  FRESH_META[String(state || '') as FreshnessState] || FRESH_META.unknown

/** 作业分类（双模式审计的两边）。 */
export const JOB_KIND_LABELS: Record<string, string> = {
  deterministic: '纯脚本',
  needsJudgement: '需模型判断',
}

export const SEVERITY_META: Record<string, { label: string; tone: 'danger' | 'warn' | 'neutral' }> = {
  high: { label: '高', tone: 'danger' },
  medium: { label: '中', tone: 'warn' },
  low: { label: '低', tone: 'neutral' },
}

/** 挂闸动作名（activeActions.action）→ 人话。后台没登记的键原样显示，不猜。 */
export const ACTION_LABELS: Record<string, string> = {
  'global-pause': '全局暂停',
  'text-only': '只出文字',
  'pause-proactive': '停主动触达',
  'pause-media': '停出图出片',
  'compress-session': '压缩会话',
  'switch-model': '换模型',
}
export const actionLabel = (action?: string) => ACTION_LABELS[String(action || '')] || String(action || '未命名动作')

export const finite = (value: unknown, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 0.20435… → "0.20"；缺值给 "—"，不要拿 0 冒充。 */
export const fixed2 = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—')

/** 0..1 → "20%"；缺值给 "—"。 */
export const percent = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) ? `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%` : '—'
}

/** 正负比：没有负向时给"零负向"，两边都空时明说没有记录。 */
export const praiseRatioText = (stats?: PraiseLedgerPayload['stats']) => {
  const positive = finite(stats?.positive)
  const negative = finite(stats?.negative)
  if (!positive && !negative) return '无记录'
  if (!negative) return `正 ${positive} · 无负向`
  return `正 ${positive} · 负 ${negative} · ${(positive / negative).toFixed(2)} : 1`
}
