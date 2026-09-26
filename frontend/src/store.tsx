import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react'
import useSWR, { mutate as globalMutate } from 'swr'
import { ModelsApi, SessionsApi, setToken, getToken, setApiBase, getApiBase } from './api'
import { mobileApiBaseError } from './lib/shell-origin'
import type { Model, Session } from './types'

interface AppState {
  authed: boolean
  token: string
  models: Model[]
  currentModel: string // "provider/id" or "auto/auto"
  cwd: string
  sessions: Session[]
  currentSessionId: string | null
  login: (token: string, apiBase?: string) => Promise<void>
  logout: () => void
  refreshModels: () => Promise<void>
  refreshSessions: () => Promise<void>
  selectSession: (sid: string | null) => void
  setCurrentModel: (mk: string) => void
}

const Ctx = createContext<AppState>(null as any)

// swr fetcher：key 即 API 路径别名（'models' / 'sessions'）
const fetchers = {
  models: () => ModelsApi.list(),
  sessions: () => SessionsApi.list(),
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [token, setT] = useState(getToken())
  const [authed, setAuthed] = useState(() => {
    if (!getToken()) return false
    const origin = typeof location !== 'undefined' ? location.origin : ''
    return !mobileApiBaseError(getApiBase(), origin)
  })
  const [currentModel, setCurModel] = useState(() => { try { return localStorage.getItem('pi_model') || 'auto/auto' } catch { return 'auto/auto' } })
  const [currentSessionId, setCurSid] = useState<string | null>(null)
  const sessionRestorePending = useRef(true)

  // ── SWR 数据层：跨端/跨标签页以服务端为准。
  // 仅靠显式动作会让另一端新建的会话在当前端长期不可见，因此恢复焦点或网络时重验。
  const { data: modelsData } = useSWR(authed ? 'models' : null, fetchers.models, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 5000,
    onErrorRetry: (_error, _key, _config, revalidate, options) => {
      if (_error?.status === 401 || options.retryCount > 3) return
      setTimeout(() => { if (getToken() === token && token) void revalidate(options) }, 8000)
    },
  })
  const { data: sessionsData } = useSWR(authed ? 'sessions' : null, fetchers.sessions, {
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
    dedupingInterval: 3000,
    onErrorRetry: (_error, _key, _config, revalidate, options) => {
      if (_error?.status === 401 || options.retryCount > 3) return
      setTimeout(() => { if (getToken() === token && token) void revalidate(options) }, 8000)
    },
  })
  const models: Model[] = modelsData?.models || []
  const cwd: string = modelsData?.cwd || ''
  const sessions: Session[] = sessionsData?.sessions || []

  const refreshModels = useCallback(async () => { await globalMutate('models') }, [])
  const refreshSessions = useCallback(async () => { await globalMutate('sessions') }, [])

  // 服务端当前模型 → 本地选择（仅在无本地偏好时同步，之后以本地为准）
  useEffect(() => {
    if (modelsData?.current && currentModel === 'auto/auto') {
      const mk = `${modelsData.current.provider}/${modelsData.current.id}`
      setCurModel(mk)
      try { localStorage.setItem('pi_model', mk) } catch {}
    }
  }, [modelsData?.current]) // eslint-disable-line

  // 模型存在性校验：本地选的模型若已下架/被清理(不在当前模型列表) → 回退服务端默认并提示。
  // 否则输入框显示 A、实际静默降级跑 B（显示与实发不一致）
  useEffect(() => {
    const list: Model[] = modelsData?.models || []
    if (!list.length || currentModel === 'auto/auto') return
    const idx = currentModel.indexOf('/')
    const exists = list.some(m => m.provider === currentModel.slice(0, idx) && m.id === currentModel.slice(idx + 1))
    if (!exists && modelsData?.current) {
      const mk = `${modelsData.current.provider}/${modelsData.current.id}`
      setCurModel(mk)
      try { localStorage.setItem('pi_model', mk) } catch {}
      // 惰性 import 避免循环依赖（Toast→store）
      import('./components/Toast').then(({ toast }) => toast(`原模型 ${currentModel} 已不可用，已切换为 ${mk}`, 'error'))
    }
  }, [modelsData, currentModel])

  const login = useCallback(async (tk: string, apiBase?: string) => {
    const origin = typeof location !== 'undefined' ? location.origin : ''
    const base = (apiBase || getApiBase()).replace(/\/+$/, '')
    const addressErr = mobileApiBaseError(base, origin)
    if (addressErr) { const e: any = new Error(addressErr); e.status = 0; throw e }
    // 先服务端真验证再放行（修「输错 token 也进主界面」的幽灵登录态）；用原生 fetch 不走 api()，避免触发全局 401 踢出
    const ctrl = new AbortController(); const tmo = setTimeout(() => ctrl.abort(), 8000)
    try {
      const r = await fetch(base + '/api/models', { headers: { Authorization: `Bearer ${tk}` }, signal: ctrl.signal })
      if (r.status === 401) { const e: any = new Error('令牌无效'); e.status = 401; throw e }
      if (!r.ok) { const e: any = new Error('服务无响应 (HTTP ' + r.status + ')'); e.status = r.status; throw e }
    } catch (e: any) {
      if (e?.name === 'AbortError') { const x: any = new Error('连接超时'); x.status = 0; throw x }
      throw e
    } finally { clearTimeout(tmo) }
    // 已退出时先作废 SWR 的旧请求去重标记；null key 的订阅不会发起请求。
    await Promise.all([globalMutate('sessions'), globalMutate('models')])
    setToken(tk); setApiBase(base)
    sessionRestorePending.current = true
    setT(tk); setAuthed(true)
  }, [])


  const logout = useCallback(() => {
    setToken(''); setApiBase('')
    sessionRestorePending.current = true
    try {
      localStorage.removeItem('pi_web_token')
      localStorage.removeItem('pi_api_base')
      localStorage.removeItem('yuanshu_access_token')
      localStorage.removeItem('yuanshu_api_base')
    } catch {}
    setT(''); setAuthed(false); setCurSid(null)
    globalMutate('sessions', undefined, { revalidate: false })
    globalMutate('models', undefined, { revalidate: false })
  }, [])

  // 全局 401 踢出：主界面里任何接口鉴权失败 → 清令牌回登录页（幽灵态不可停留）
  useEffect(() => {
    const onUn = () => { if (getToken()) logout() }
    window.addEventListener('pi-unauthorized', onUn)
    return () => window.removeEventListener('pi-unauthorized', onUn)
  }, [logout])

  // 同一次登录只恢复一次，复用 SWR 的目录请求；主动选择（包括空会话）优先。
  useEffect(() => {
    if (!authed || !sessionsData || !sessionRestorePending.current) return
    sessionRestorePending.current = false
    const last = (() => { try { return localStorage.getItem('pi_last_session') } catch { return null } })()
    if (last && (sessionsData.sessions || []).some((s: Session) => s.id === last)) setCurSid(prev => prev ?? last)
  }, [authed, sessionsData])

  const value: AppState = {
    authed, token, models, currentModel, cwd, sessions, currentSessionId,
    login, logout, refreshModels, refreshSessions,
    selectSession: (sid) => { sessionRestorePending.current = false; setCurSid(sid); if (sid) { try { localStorage.setItem('pi_last_session', sid) } catch {} } },
    setCurrentModel: (mk) => { setCurModel(mk); try { localStorage.setItem('pi_model', mk) } catch {} },
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useApp = () => useContext(Ctx)
