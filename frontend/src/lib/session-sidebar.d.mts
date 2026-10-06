import type { Session } from '../types'

export interface SidebarBucket { key: string; label: string; items: Session[] }
export interface SidebarSection { key: string; label: string; count: number; items?: Session[]; buckets?: SidebarBucket[] }

export const SESSION_GROUPS: { key: string; label: string }[]
export const TIME_BUCKETS: { key: string; label: string }[]
export const DEFAULT_COLLAPSED: string[]
export function timeBucketOf(iso: string | undefined, now?: number): 'today' | 'yesterday' | 'week' | 'month' | 'older'
export function displayName(s: Partial<Session> | null | undefined): string
export function matchesSearch(s: Partial<Session> | null | undefined, kw: string): boolean
export function planSidebar(sessions: Session[], opts?: { now?: number; search?: string }): SidebarSection[]
