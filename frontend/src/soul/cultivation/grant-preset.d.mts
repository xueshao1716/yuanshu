import type { Design, Policy, Preflight } from './api'
import type { KnowledgePolicyData } from '../../knowledge/api'
type Blocked = Preflight['blockedBy'][number]
export const GRANT_DAYS: number
export const GRANT_DAILY_REQUESTS: number
export const GRANT_DAILY_BUDGET_CENTS: number
export const GRANT_SCOPE: string
export const GRANTABLE_FIELDS: string[]
export const SHARED_FIELDS: string[]
export const REASONING_OUTPUT_TOKENS: number
export const GRANT_TIMEOUT_MS: number
export const grantSummary: string
export function supportedDesign(design: Design['design']): boolean
export function grantPolicy(design: Design['design'], now?: number): Policy
export function classifyBlocked(blockedBy: Blocked[] | undefined, opts?: { includeShared?: boolean }): { fixable: Blocked[]; shared: Blocked[]; stubborn: Blocked[] }
export function sharedPatch(knowledgePolicy: KnowledgePolicyData | undefined, model: string, catalogCost?: { input: number; output: number }, opts?: { reasoning?: boolean }):
  { needsManualPrice: boolean; patch: Partial<KnowledgePolicyData> | null } | null
