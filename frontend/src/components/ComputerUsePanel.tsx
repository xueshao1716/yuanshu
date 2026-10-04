import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { Monitor, Square } from 'lucide-react'
import { api, ConfirmApi, SessionsApi } from '../api'
import SectionHeader from './SectionHeader'
import { useApp } from '../store'

type DesktopWindow = { id: string; title: string; process: string }
type Status = {
  supported: boolean; enabled: boolean; busy: boolean
  grant: { scope?: 'desktop'; sessionId: string; window: DesktopWindow; expiresAt: number } | null
  pending: { id: string; sessionId: string; reason: string }[]
}

export default function ComputerUsePanel() {
  // Keep one visible permission concept: a time-limited desktop session.
  // Window selection is an observation target, never a second permission.
  const { selectSession } = useApp()
  const { data: status, error: statusError, mutate } = useSWR<Status>('computer-status', () => api('/api/computer/status'), {
    refreshInterval: data => data?.enabled ? 2000 : 0, revalidateOnFocus: true, shouldRetryOnError: false,
  })
  const [windows, setWindows] = useState<DesktopWindow[]>([])
  const [sessions, setSessions] = useState<{ id: string; name?: string }[]>([])
  const [windowId, setWindowId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [choosingTarget, setChoosingTarget] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function perform(work: () => Promise<void>) {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try { await work() }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '请求失败，请重试') }
    finally { if (mounted.current) { setBusy(false); void mutate() } }
  }
  async function loadTargets() {
    const [desktop, chats] = await Promise.all([
      api<{ windows: DesktopWindow[] }>('/api/computer/windows'), SessionsApi.list(),
    ])
    if (!mounted.current) return
    setWindows(desktop.windows); setSessions(chats.sessions); setWindowId(''); setLoaded(true)
  }
  async function grant() {
    await api('/api/computer/grant', { method: 'POST', body: { windowId, sessionId } })
    if (mounted.current) setMessage('本次桌面操作已授权。目标窗口只是观察位置；真正改变内容时，聊天里只确认那一步。')
  }
  async function chooseTarget() {
    if (!active || !windowId) return
    await api('/api/computer/target', { method: 'POST', body: { windowId, sessionId: active.sessionId } })
    if (mounted.current) { setChoosingTarget(false); setMessage('已切换当前观察窗口；桌面授权范围保持不变。') }
  }
  async function answer(session: string, id: string, allowed: boolean) {
    const result = await ConfirmApi.answer(session, id, allowed)
    if (!result.ok) throw new Error((result as { error?: string }).error || '确认已过期，请重新观察窗口')
  }
  async function stop() {
    setStopping(true); setError('')
    try {
      await api('/api/computer/stop', { method: 'POST' })
      if (mounted.current) { setMessage('已停止并撤销授权。已执行的操作不能自动撤销。'); void mutate() }
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : '停止失败，请重试') }
    finally { if (mounted.current) setStopping(false) }
  }
  const active = status?.enabled && status.grant
  return (
    <section data-slot="computer-use" className="mb-8">
      <SectionHeader title="电脑操作（一次授权）" description="只需开一个本次桌面授权。普通应用可以切换观察窗口，不需要分别给元枢、应用或窗口开权限；真正改变内容时只确认那一步。" />
      <div className="panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-pi-text"><Monitor size={18} aria-hidden="true" />
            {statusError ? '本机连接不可用' : !status ? '读取状态…' : active ? '本次桌面授权已开' : '未授权 · 默认关闭'}
          </span>
          <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-2" disabled={stopping} onClick={stop}>
            <Square size={14} aria-hidden="true" />{stopping ? '正在停止…' : '立即停止'}
          </button>
        </div>
        <p className="text-sm leading-relaxed text-pi-dim">
          这是一个限时的本次桌面授权，不再拆成应用权限或窗口权限。
          支持桌面上可被 Windows 无障碍接口读取的普通应用；浏览器、终端、密码/认证、安全设置等高风险界面会被拦截，不使用坐标点击。读取到的屏幕文字会进入所选会话，并可能发送给该会话使用的模型，请先关闭敏感内容。
        </p>
        {active ? <div className="space-y-2 text-sm text-pi-text">
          <p className="break-words">授权范围：本次受控桌面会话（普通应用）</p>
          <p className="break-words">应用与窗口无需另开权限；下面只选择当前观察目标。</p>
          <p className="break-words">当前观察窗口：{active.window.title} · {active.window.process}</p>
          <p>授权截至 {new Date(active.expiresAt).toLocaleTimeString()}，离开本页不会立即撤销。</p>
          <button type="button" className="btn-ghost min-h-11 px-3" disabled={busy} onClick={() => perform(async () => { setChoosingTarget(true); await loadTargets() })}>切换目标窗口</button>
          {choosingTarget && <div className="space-y-3">
            <label className="text-sm text-pi-text space-y-2">新的观察窗口
              <select aria-label="新的观察窗口" className="input-pi min-h-11 w-full min-w-0 block" value={windowId} onChange={e => setWindowId(e.target.value)}>
                <option value="">请选择窗口</option>{windows.map(w => <option key={w.id} value={w.id}>{w.title} · {w.process}</option>)}
              </select>
            </label>
            <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || !windowId} onClick={() => perform(chooseTarget)}>应用观察窗口</button>
          </div>}
          <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center" onClick={() => { selectSession(active.sessionId); location.hash = '#/chat' }}>回到操作会话</button>
        </div> : <>
          <button type="button" className="btn-ghost min-h-11 px-3" disabled={busy || !status?.supported || !!statusError} onClick={() => perform(loadTargets)}>
            {busy ? '正在处理…' : loaded ? '重新读取可用窗口' : '选择会话与窗口'}
          </button>
          {status && !status.supported && <p className="text-sm text-pi-dim">需要在 Windows 电脑上运行元枢，并保持桌面已登录。</p>}
          {loaded && <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="text-sm text-pi-text space-y-2">操作会话
                <select aria-label="操作会话" className="input-pi min-h-11 w-full min-w-0 block" value={sessionId} onChange={e => setSessionId(e.target.value)}>
                  <option value="">请选择会话</option>{sessions.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
                </select>
              </label>
              <label className="text-sm text-pi-text space-y-2">目标窗口
                <select aria-label="目标窗口" className="input-pi min-h-11 w-full min-w-0 block" value={windowId} onChange={e => setWindowId(e.target.value)}>
                  <option value="">请选择窗口</option>{windows.map(w => <option key={w.id} value={w.id}>{w.title} · {w.process}</option>)}
                </select>
              </label>
            </div>
            {!windows.length && <p className="text-sm text-pi-dim">没有找到可观察的桌面窗口。请确认桌面已登录，并重新读取；某些应用不提供可操作控件。</p>}
            {!sessions.length && <p className="text-sm text-pi-dim">请先创建一个聊天会话，再回来授权。</p>}
            <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || !windowId || !sessionId} onClick={() => perform(grant)}>授权本次桌面操作 10 分钟</button>
          </div>}
        </>}
        {status?.pending.map(p => <div key={p.id} className="border-t border-pi-border-soft pt-4 space-y-3">
          <p className="font-medium text-sm text-pi-text">只确认这一步操作</p>
          <p className="text-sm text-pi-text whitespace-pre-wrap break-words">{p.reason}</p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-ghost min-h-11 px-4" disabled={busy} onClick={() => perform(() => answer(p.sessionId, p.id, false))}>拒绝本次</button>
            <button type="button" className="btn-primary min-h-11 px-4" disabled={busy} onClick={() => perform(() => answer(p.sessionId, p.id, true))}>仅允许这一步</button>
          </div>
        </div>)}
        {(error || statusError) && <p role="alert" className="text-sm text-pi-danger break-words">{error || statusError?.message}</p>}
        {message && <p role="status" className="text-sm text-pi-dim break-words">{message}</p>}
      </div>
    </section>
  )
}
