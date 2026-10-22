import { useEffect, useState } from 'react'
import { ServiceApi, type WatchdogStatus } from '../api'

/**
 * 守护状态（2026-10-22，方案 B+D）
 *
 * B：Windows 服务 YuanShuService（无窗口、注销后仍在跑）
 * D：桌面端能看状态、能重启（服务 SDDL 已授予交互用户启动/停止权限，不需要每次 UAC）
 */
export default function ServiceStatusCard() {
  const [st, setSt] = useState<WatchdogStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')

  const load = () => {
    ServiceApi.status().then(s => { setSt(s); setErr('') }).catch(e => setErr(String(e?.message || e)))
  }
  useEffect(() => { load(); const t = window.setInterval(load, 8000); return () => window.clearInterval(t) }, [])

  const run = async (action: 'start' | 'restart' | 'stop') => {
    setBusy(action); setNote(''); setErr('')
    try {
      const r = await ServiceApi.control(action)
      if (r.ok) {
        setNote(action === 'restart' ? '已发出重启指令，服务会在几秒内重新就绪' : '已发出指令')
        window.setTimeout(load, 3000)
        window.setTimeout(load, 8000)
      } else {
        setErr(r.message || r.error || '操作失败')
      }
    } catch (e: any) {
      // 服务模式下重启会先断开当前连接，这里不当作失败
      if (action === 'restart') setNote('已发出重启指令，连接会短暂中断')
      else setErr(String(e?.message || e))
    } finally {
      setBusy('')
    }
  }

  const modeText = st?.mode === 'service' ? 'Windows 服务' : st?.mode === 'task' ? '计划任务' : '未安装守护'
  const stateText = (() => {
    const s = String(st?.state || '').toUpperCase()
    if (s.includes('RUNNING') && !s.includes('NOT_')) return '运行中'
    if (s.includes('STOPPED')) return '已停止'
    if (s.includes('PENDING')) return '切换中'
    if (s === 'READY') return '就绪（等待触发）'
    if (s === 'DISABLED') return '已禁用'
    return s || '未知'
  })()
  const healthy = stateText === '运行中' || stateText === '就绪（等待触发）'

  return (
    <div className="space-y-2 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
        <span className="text-pi-dim2">形态</span>
        <strong className="text-pi-text">{modeText}</strong>
        <span className="text-pi-dim2">状态</span>
        <strong className={healthy ? 'text-pi-green' : 'text-red-500'}>{stateText}</strong>
        {st?.pid && <span className="text-pi-dim2">PID {st.pid}</span>}
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        <button onClick={() => run('start')} disabled={!!busy}
          className="rounded-pi-md border border-pi-border-soft px-3 py-1.5 text-[12px] hover:bg-pi-surface disabled:opacity-50">启动</button>
        <button onClick={() => run('restart')} disabled={!!busy}
          className="rounded-pi-md bg-pi-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50">
          {busy === 'restart' ? '重启中…' : '重启服务'}
        </button>
        {st?.mode === 'service' && (
          <button onClick={() => run('stop')} disabled={!!busy}
            className="rounded-pi-md border border-pi-border-soft px-3 py-1.5 text-[12px] hover:bg-pi-surface disabled:opacity-50">停止</button>
        )}
      </div>
      {note && <p className="text-[12px] text-pi-accent">{note}</p>}
      {err && <p className="text-[12px] text-red-500">{err}</p>}
      <p className="pt-1 text-[11px] leading-relaxed text-pi-dim2">
        服务形态开机即启、注销后仍在跑，没有控制台窗口；计划任务是回退方案（不需要管理员）。
        重启会中断正在进行的流式回答。
      </p>
    </div>
  )
}
