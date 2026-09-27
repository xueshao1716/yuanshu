import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, RefreshCw, X } from 'lucide-react'
import { useApp } from '../store'
import { SystemApi } from '../api'

const CHECK_KEY = 'yuanshu_update_notice_check_at'
const DISMISSED_KEY = 'yuanshu_update_notice_dismissed_sha'
const CHECK_INTERVAL = 30 * 60 * 1000

type UpdateInfo = {
  source?: string
  localSha?: string
  remote?: { sha?: string; message?: string; date?: string }
  upToDate?: boolean
  checkable?: boolean
}

/** 全局更新提醒：只提醒，不静默拉取；更新和重启始终由用户确认。 */
export default function UpdateNotice() {
  const { authed } = useApp()
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const check = useCallback(async (force = false) => {
    if (!authed) return
    if (!force) {
      try {
        const at = Number(localStorage.getItem(CHECK_KEY) || 0)
        if (Date.now() - at < CHECK_INTERVAL) return
        localStorage.setItem(CHECK_KEY, String(Date.now()))
      } catch {}
    }
    try {
      const result = await SystemApi.checkUpdate() as UpdateInfo
      if (!result?.upToDate && result?.checkable !== false && result?.remote?.sha) {
        let dismissed = ''
        try { dismissed = localStorage.getItem(DISMISSED_KEY) || '' } catch {}
        if (dismissed !== result.remote.sha) setUpdate(result)
      }
    } catch {}
  }, [authed])

  useEffect(() => {
    void check()
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL)
    return () => window.clearInterval(timer)
  }, [check])

  const later = () => {
    try { if (update?.remote?.sha) localStorage.setItem(DISMISSED_KEY, update.remote.sha) } catch {}
    setUpdate(null)
  }

  const apply = async () => {
    if (busy) return
    if (!window.confirm('更新会拉取代码并重启服务，当前流式任务会中断。确定立即更新吗？')) return
    setBusy(true); setMessage('正在拉取更新并准备重启…')
    try {
      const result = await SystemApi.applyUpdate()
      setMessage(result?.message || '更新已提交，服务正在重启…')
    } catch (e: any) {
      setBusy(false)
      setMessage(e?.message || '更新失败：请稍后在系统页重试')
    }
  }

  if (!update) return null
  const sha = update.remote?.sha || ''
  const date = update.remote?.date ? new Date(update.remote.date).toLocaleString('zh-CN', { hour12: false }) : ''
  return (
    <section role="dialog" aria-label="发现新版本" className="fixed z-[var(--pi-z-modal)] right-4 top-4 w-[min(92vw,430px)] rounded-pi-lg border border-pi-accent/35 bg-pi-bg1 shadow-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-pi-accent/15 text-pi-accent p-2"><Download className="w-4 h-4" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-pi-text">发现新版本</h2>
            <button type="button" className="btn-tool !p-1" onClick={later} aria-label="稍后处理"><X className="w-4 h-4" /></button>
          </div>
          <p className="mt-1 text-xs text-pi-dim">当前 {update.localSha || '未知'} → 远端 {sha}{update.source ? ` · ${update.source}` : ''}</p>
          {update.remote?.message && <p className="mt-2 text-xs leading-relaxed text-pi-text break-words">{update.remote.message}</p>}
          {date && <p className="mt-1 text-[11px] text-pi-dim2">提交时间：{date}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5" disabled={busy} onClick={() => void apply()}>
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />{busy ? '更新中…' : '立即更新'}
            </button>
            <button type="button" className="btn-tool text-xs !px-3 !py-1.5" disabled={busy} onClick={later}>稍后</button>
          </div>
          {message && <p className="mt-2 text-[11px] text-pi-dim2" role="status">{message}</p>}
          {!message && <p className="mt-2 text-[11px] text-pi-warning inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" aria-hidden="true" />更新会重启服务，正在进行的流式任务会中断</p>}
        </div>
      </div>
    </section>
  )
}
