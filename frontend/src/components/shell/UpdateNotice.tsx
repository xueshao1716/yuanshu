import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Download, RefreshCw, X } from 'lucide-react'
import { useApp } from '../../store'
import { SystemApi } from '../../api'
import { PRODUCT_VERSION } from '../../lib/artifact-name'
import { toast } from './Toast'

const CHECK_KEY = 'yuanshu_update_notice_check_at'
const DISMISSED_KEY = 'yuanshu_update_notice_dismissed_sha'
const CHECK_INTERVAL = 30 * 60 * 1000

type UpdateInfo = {
  source?: string
  localSha?: string
  remote?: { sha?: string; message?: string; date?: string }
  upToDate?: boolean
  checkable?: boolean
  relation?: string
  remoteVersion?: string
  important?: boolean // 2026-11-23：中间有没有标了「大更新」的版本；false = 小更新，服务端空闲时自己装
}

const SILENT_KEY = 'yuanshu_silent_updated_from'
// 手机 App 的页面打包在 APK 里，刷新也换不了代码，不参与静默刷新
const bundledShell = () => !!(globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()

/** 服务端静默更新后，页面里还是旧代码：找个不打扰的时机（切到后台、或 3 分钟没操作）自己刷新 */
function useSilentReload() {
  useEffect(() => {
    if (bundledShell()) return
    try {
      const from = sessionStorage.getItem(SILENT_KEY)
      if (from && from !== PRODUCT_VERSION) toast(`已在后台更新到 v${PRODUCT_VERSION}`, 'ok')
      sessionStorage.removeItem(SILENT_KEY)
    } catch {}
    let stale = false, lastInput = Date.now()
    const reload = () => { try { sessionStorage.setItem(SILENT_KEY, PRODUCT_VERSION) } catch {}; window.location.reload() }
    const typing = () => { const a = document.activeElement as HTMLInputElement | null; return !!a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && !!a.value }
    const maybe = () => { if (stale && !typing() && (document.visibilityState === 'hidden' || Date.now() - lastInput > 3 * 60_000)) reload() }
    const poll = async () => {
      try {
        const h = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(4000) })
        const v = h.ok ? String((await h.json())?.version || '') : ''
        if (v && /^\d+\.\d+\.\d+/.test(PRODUCT_VERSION) && v !== PRODUCT_VERSION) stale = true
      } catch {}
      maybe()
    }
    const onInput = () => { lastInput = Date.now() }
    const timer = window.setInterval(() => void poll(), 60_000)
    document.addEventListener('visibilitychange', maybe)
    for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, onInput, { passive: true })
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', maybe)
      for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, onInput)
    }
  }, [])
}

/** 全局更新提醒：大更新才弹窗让用户确认；小更新由服务端空闲时静默装（engine/auto-update.mjs），页面自己刷新。 */
export default function UpdateNotice() {
  const { authed } = useApp()
  useSilentReload()
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // 2026-10-19 修：更新完只显示"正在重启"，既不知道成没成功、也没有刷新入口。
  // 现在分四态：applying → waiting（轮询等它回来）→ done / failed。
  const [phase, setPhase] = useState<'idle' | 'applying' | 'waiting' | 'done' | 'failed'>('idle')
  const [newVersion, setNewVersion] = useState('')

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
      // 小更新且确实落后：服务端会挑空闲时自己装，这里不打扰
      const quiet = result?.important === false && result?.relation === 'behind'
      if (!quiet && !result?.upToDate && result?.checkable !== false && result?.remote?.sha) {
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
    setBusy(true); setPhase('applying'); setMessage('正在拉取更新并准备重启…')
    try {
      const result = await SystemApi.applyUpdate()
      setPhase('waiting'); setMessage(result?.message || '服务正在重启，等待它回来…')
      const version = await waitForServer()
      if (version) {
        setNewVersion(version)
        setPhase('done')
        setMessage(`已更新到 v${version}。页面里跑的还是旧代码，刷新后生效。`)
        // 8 秒后自动刷新；用户也可以立刻点。
        window.setTimeout(() => window.location.reload(), 8000)
      } else {
        setPhase('failed')
        setMessage('等了 2 分钟服务还没回来。请到「系统」页检查，或手动重启元枢。')
      }
    } catch (e: any) {
      setPhase('failed')
      setMessage(e?.message || '更新失败：请稍后在系统页重试')
    } finally {
      setBusy(false)
    }
  }

  // 轮询等重启完成：拿到 version 就说明服务回来了
  const waitForServer = async (timeoutMs = 120000): Promise<string> => {
    const start = Date.now()
    await new Promise(r => setTimeout(r, 3000)) // 先给它时间真的开始重启
    while (Date.now() - start < timeoutMs) {
      try {
        const info = await SystemApi.info()
        if (info?.version) return String(info.version)
      } catch { /* 还在重启，继续等 */ }
      await new Promise(r => setTimeout(r, 2000))
    }
    return ''
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
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            {phase === 'done' ? (
              <button type="button" className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5" onClick={() => window.location.reload()}>
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />立即刷新
              </button>
            ) : (
              <button type="button" className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5" disabled={busy} onClick={() => void apply()}>
                <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />{busy ? '更新中…' : '立即更新'}
              </button>
            )}
            {phase === 'failed' && (
              <button type="button" className="btn-tool text-xs !px-3 !py-1.5" onClick={() => { setPhase('idle'); setMessage(''); void check(true) }}>重新检查</button>
            )}
            <button type="button" className="btn-tool text-xs !px-3 !py-1.5" disabled={busy} onClick={later}>稍后</button>
          </div>
          {message && <p className="mt-2 text-[11px] text-pi-dim2" role="status">{message}</p>}
          {phase === 'done' && <p className="mt-1 text-[11px] text-pi-dim2">8 秒后自动刷新，也可以点「立即刷新」</p>}
          {phase === 'waiting' && <p className="mt-1 text-[11px] text-pi-dim2 inline-flex items-center gap-1"><RefreshCw className="w-3 h-3 animate-spin" aria-hidden="true" />等待服务重启…</p>}
          {!message && <p className="mt-2 text-[11px] text-pi-warning inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" aria-hidden="true" />更新会重启服务，正在进行的流式任务会中断</p>}
        </div>
      </div>
    </section>
  )
}
