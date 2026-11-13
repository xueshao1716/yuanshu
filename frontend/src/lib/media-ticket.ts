// AUTH-003（2026-11-13）：把长期令牌从媒体 URL 里换掉。
//
// <img>/<audio>/<video>/SSE 带不了 Authorization 头，以前只能把 ?token=<长期令牌> 拼进 URL，
// 于是令牌会进浏览器历史、代理访问日志和 Referer。现在的做法：
//   Bearer 调 POST /api/ticket 换一张 60 秒的短时票据，URL 里只出现 ?ticket=。
// 本模块只负责"算 scope / 拼 URL / 管缓存"这三件纯逻辑，网络与降级留在 api.ts
// （那里才认识令牌与 api()，也才需要 console.warn 一次）。

export const TICKET_CACHE_MS = 45_000
/** 票据剩余寿命低于这个值就当"该换票了"：宁可用旧票撑一下，也不让图片卡在 401 上。 */
export const TICKET_MIN_REMAIN_MS = 5_000
/** 换票失败后的冷却：旧后端（没有 /api/ticket）或网络抖动时，别让每张图都去打一次接口。 */
export const TICKET_RETRY_MS = 30_000

export type TicketEntry = { ticket: string; exp: number; at: number }
export type TicketTransport = (scope: string) => Promise<{ ticket?: string; exp?: number; scope?: string }>

export type TicketStoreOptions = {
  now?: () => number
  cacheMs?: number
  minRemainMs?: number
  retryMs?: number
}

/**
 * 从 URL 反推需要哪一类票据；空串 = 这条路径不需要票据（保持原样）。
 * 必须与 engine/media-ticket.mjs 的 ticketScopeForPath 保持一致（有对拍测试）。
 */
export function ticketScopeForUrl(url: string): string {
  if (!url) return ''
  let pathname = ''
  try { pathname = new URL(url, 'http://workspace.invalid').pathname } catch { return '' }
  if (pathname === '/api/ws/file') return 'file:'
  if (pathname.startsWith('/api/media/')) return 'media:'
  // 只认 /api/<一段>/stream；/api/sessions/<id>/stream 这类多段路径仍只走 Authorization 头。
  const stream = /^\/api\/([A-Za-z0-9_-]+)\/stream$/.exec(pathname)
  if (stream) return `stream:${stream[1]}`
  return ''
}

/** 把票据写进 URL：先清掉历史残留的 token/sig/exp/ticket，再补 scope 对应的 api base。 */
export function withTicketParam(url: string, base: string, ticket: string): string {
  const parsed = new URL(url, 'http://workspace.invalid')
  for (const key of ['sig', 'exp', 'token', 'ticket']) parsed.searchParams.delete(key)
  parsed.searchParams.set('ticket', ticket)
  const root = String(base || '').replace(/\/+$/, '')
  return `${root}${parsed.pathname}?${parsed.searchParams}`
}

/**
 * 按 scope 分桶的票据缓存（45 秒内复用，票快过期时后台续期）。
 * 同步入口 sync() 只返回"此刻还能用"的票据；拿不到就返回空串，由调用方决定降级到旧 ?token=。
 */
export function createTicketStore(transport: TicketTransport, options: TicketStoreOptions = {}) {
  const now = options.now || (() => Date.now())
  const cacheMs = options.cacheMs ?? TICKET_CACHE_MS
  const minRemainMs = options.minRemainMs ?? TICKET_MIN_REMAIN_MS
  const retryMs = options.retryMs ?? TICKET_RETRY_MS
  const entries = new Map<string, TicketEntry>()
  const failedAt = new Map<string, number>()
  const inflight = new Map<string, Promise<string | null>>()

  function usable(scope: string, at: number): string {
    const hit = entries.get(scope)
    if (!hit) return ''
    // exp 由服务端签发，单位毫秒（与 Date.now() 同源）
    if (hit.exp - at <= minRemainMs) return ''
    return hit.ticket
  }

  function needsRenew(scope: string, at: number): boolean {
    const hit = entries.get(scope)
    if (!hit) return true
    if (at - hit.at >= cacheMs) return true
    return hit.exp - at <= minRemainMs
  }

  function coolingDown(scope: string, at: number): boolean {
    const failed = failedAt.get(scope)
    return failed !== undefined && at - failed < retryMs
  }

  async function get(scope: string): Promise<string | null> {
    if (!scope) return null
    const at = now()
    const cached = usable(scope, at)
    if (cached && !needsRenew(scope, at)) return cached
    const running = inflight.get(scope)
    if (running) return running
    if (coolingDown(scope, at)) return cached || null
    const task = (async () => {
      try {
        const response = await transport(scope)
        const ticket = typeof response?.ticket === 'string' ? response.ticket : ''
        const exp = Number(response?.exp)
        if (!ticket || !Number.isFinite(exp)) throw new Error('票据响应不完整')
        entries.set(scope, { ticket, exp, at: now() })
        failedAt.delete(scope)
        return ticket
      } catch {
        failedAt.set(scope, now())
        return null
      } finally {
        inflight.delete(scope)
      }
    })()
    inflight.set(scope, task)
    return task
  }

  /** 同步取票：有能用的票就直接给，需要续期就丢到后台换（不阻塞渲染）。拿不到返回空串。 */
  function sync(scope: string): string {
    if (!scope) return ''
    const at = now()
    const ticket = usable(scope, at)
    if (needsRenew(scope, at)) void get(scope)
    return ticket
  }

  /** 只读快照（测试/诊断用，不触发换票）。 */
  function peek(scope: string): string {
    return usable(scope, now())
  }

  function clear(): void {
    entries.clear()
    failedAt.clear()
    inflight.clear()
  }

  return { get, sync, peek, clear }
}

export type TicketStore = ReturnType<typeof createTicketStore>
