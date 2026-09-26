import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { Shield, AlertTriangle } from 'lucide-react'
import { SandboxApi } from '../../api'
import { useApp } from '../../store'
import MaintenanceModePanel from './MaintenanceModePanel'

// 会话级沙箱模式（台前）。引擎侧是 append-only 日志 + fold：收紧随时可以，放宽必须写明理由。
// 这里只负责把「当前是什么档、切到哪、什么时候被谁为什么放宽过」摊开给人看。
const RANK = ['read-only', 'workspace-write', 'danger-full-access']
const rank = (m?: string) => RANK.indexOf(String(m || ''))

export default function SandboxModePanel() {
  const { currentSessionId } = useApp()
  if (!currentSessionId) return <section className="border-t border-pi-border-soft py-5"><h2 className="text-sm font-semibold text-pi-text">沙箱与超维模式</h2><p role="status" className="text-sm text-pi-dim mt-2">请先选择一个会话，再查看或调整权限。</p></section>
  return <SessionSandboxModePanel key={currentSessionId} sessionId={currentSessionId} />
}

function SessionSandboxModePanel({ sessionId }: { sessionId: string }) {
  const { data, error, mutate, isLoading } = useSWR(['sandbox-mode', sessionId], () => SandboxApi.get(sessionId), { dedupingInterval: 15000, keepPreviousData: false })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const mounted = useRef(true)
  const inFlight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const presets = data?.presets || []

  const pick = async (id: string) => {
    if (inFlight.current || error || !data || data.sessionId !== sessionId || id === data.preset) return
    const target = presets.find(p => p.id === id)
    const widening = rank(target?.mode) > rank(data?.mode)
    let reason = ''
    if (widening) {
      const r = prompt(`放宽到「${target?.label}」（${target?.mode}）必须写明理由，会记进审计日志。\n\n这个会话为什么需要放宽？`)
      if (r === null) return
      reason = r.trim()
      if (!reason) { setMsg('请填写放宽权限的理由。'); return }
    }
    inFlight.current = true
    setBusy(id); setMsg('')
    try {
      const res = await SandboxApi.set(sessionId, id, reason)
      if (!mounted.current) return
      if (!res.ok) setMsg(res.reason || '切换被拒')
      await mutate()
    } catch (e: any) { if (mounted.current) setMsg('切换失败：' + (e?.message || e)) }
    finally { inFlight.current = false; if (mounted.current) setBusy('') }
  }

  return <><section className="border-t border-pi-border-soft py-5" aria-labelledby="sandbox-mode-title">
    <h2 id="sandbox-mode-title" className="text-sm font-semibold text-pi-text mb-1 inline-flex items-center gap-2"><Shield className="w-4 h-4" />沙箱模式（本会话）</h2>
    <p className="text-sm text-pi-dim mb-3 leading-relaxed break-words">
      作用于元枢自制循环（yuanshu），不覆盖 Pi SDK。切换写入会话记录——
      <span className="text-pi-text">收紧随时可以，放宽必须写明理由</span>。
      计划模式永远强制只看不改。已开始的任务不会因此自动切换权限，新轮次读取新档位。
    </p>
    <p className="text-sm text-pi-dim mb-3 break-all">目标会话：{sessionId}</p>
    {msg && <p role="alert" className="text-sm text-pi-warning mb-2 inline-flex items-center gap-2 break-words"><AlertTriangle className="w-4 h-4 shrink-0" />{msg}</p>}
    {error || (data && data.sessionId !== sessionId) ? <div role="alert" className="text-sm text-pi-warning"><p>无法确认本会话沙箱状态，暂不可切换。</p><button type="button" className="min-h-11 underline" onClick={() => void mutate().catch(() => {})}>重新读取</button></div> : isLoading || !data ? <p role="status" className="text-sm text-pi-dim">正在读取沙箱模式…</p> : (
      <div className="grid sm:grid-cols-3 gap-2">
        {presets.map(p => {
          const active = p.id === data?.preset
          return <button key={p.id} type="button" disabled={!!busy || active} onClick={() => void pick(p.id)}
            aria-pressed={active}
            className={`text-left p-3 rounded-pi-md border transition-colors min-h-11 disabled:cursor-default ${active ? 'border-pi-accent bg-pi-bg3' : 'border-pi-border-soft hover:bg-pi-bg-hover'}`}>
            <span className="block text-sm text-pi-text font-medium">{p.label}{active ? ' · 当前' : ''}{p.id === data?.defaultPreset ? ' · 默认' : ''}</span>
            <span className="block text-[11px] text-pi-dim2 mt-1 break-words font-mono">{p.mode}</span>
            <span className="block text-[11px] text-pi-dim mt-1 leading-relaxed break-words">{p.desc}</span>
          </button>
        })}
      </div>
    )}
    {busy && <p role="status" className="text-sm text-pi-dim mt-2">正在保存本会话设置…</p>}
    {!error && data?.sessionId === sessionId && data?.history?.length ? <div className="mt-4">
      <h3 className="text-sm font-medium text-pi-text mb-2">模式变化史（新的在前）</h3>
      <div className="divide-y divide-pi-border-soft">
        {data.history.slice(0, 6).map((h, i) => <div key={`${h.at}-${i}`} className="py-2 text-sm text-pi-dim flex flex-wrap gap-x-3 gap-y-1">
          <span className="font-mono text-pi-dim2">{String(h.at).replace('T', ' ').slice(0, 16)}</span>
          <span className="text-pi-text">{h.from} → {h.preset}</span>
          <span className={h.widening ? 'text-pi-warning' : ''}>{h.widening ? '放宽' : '收紧'}</span>
          <span>{h.origin === 'model' ? '模型记录' : '界面/API 记录'}</span>
          {h.reason ? <span className="break-words">理由：{h.reason}</span> : null}
        </div>)}
      </div>
    </div> : null}
  </section><MaintenanceModePanel sessionId={sessionId} /></>
}
