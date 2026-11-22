import { useCallback, useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useApp } from '../../store'
import { api } from '../../api'

// 2026-11-20 手机端新版本提醒：UpdateNotice 只管电脑上的代码，APK 有没有新版 App 自己不知道。
// 只在元枢安卓 App 里出现（有 window.YuanshuUpdate）；版本比对用电脑「安装包」目录里最新的 APK。
type UpdateBridge = { version: () => string; install: () => void }
type Latest = { notify?: string; android: { version: string; size: number; builtAt: string } | null }
type Progress = { state: 'downloading' | 'installing' | 'failed'; percent: number; error: string }

const DISMISSED_KEY = 'yuanshu_apk_dismissed_version'
// 2026-11-23 更新太勤有人嫌烦：只有中间夹着「大更新」（服务端 notify）才弹窗；
// 小版本不弹，只告诉「更多」菜单有新版（事件 yuanshu-apk-available），用户想装自己点（事件 yuanshu-apk-show）
export const APK_AVAILABLE_EVENT = 'yuanshu-apk-available'
export const APK_SHOW_EVENT = 'yuanshu-apk-show'
let available = ''
export const availableApk = () => available
const bridge = () => (globalThis as { YuanshuUpdate?: UpdateBridge }).YuanshuUpdate

export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(n => Number(n) || 0), pb = b.split('.').map(n => Number(n) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

export default function AppUpdateNotice() {
  const { authed } = useApp()
  const [latest, setLatest] = useState<{ version: string; size: number } | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)

  const check = useCallback(async () => {
    const b = bridge()
    if (!authed || !b) return
    try {
      const r = await api<Latest>('/api/app/latest')
      const mine = b.version()
      if (!r.android || !mine || !newerVersion(r.android.version, mine)) return setLatest(null)
      available = r.android.version
      try { window.dispatchEvent(new CustomEvent(APK_AVAILABLE_EVENT, { detail: available })) } catch {}
      if (!r.notify || !newerVersion(r.notify, mine)) return // 小更新：不打扰
      let dismissed = ''
      try { dismissed = localStorage.getItem(DISMISSED_KEY) || '' } catch {}
      if (dismissed !== r.android.version) setLatest(r.android)
    } catch {}
  }, [authed])

  useEffect(() => {
    void check()
    // 切回前台再查一次：装完新版回来、或我刚放了新包
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    document.addEventListener('visibilitychange', onVisible)
    const onProgress = (e: Event) => setProgress((e as CustomEvent<Progress>).detail)
    window.addEventListener('yuanshu-update', onProgress)
    // 「更多」菜单里点了「安装新版」：不管大小更新都直接弹出来
    const onShow = async () => {
      try { const r = await api<Latest>('/api/app/latest'); if (r.android) setLatest(r.android) } catch {}
    }
    window.addEventListener(APK_SHOW_EVENT, onShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('yuanshu-update', onProgress)
      window.removeEventListener(APK_SHOW_EVENT, onShow)
    }
  }, [check])

  if (!latest) return null
  const later = () => { try { localStorage.setItem(DISMISSED_KEY, latest.version) } catch {}; setLatest(null) }
  const busy = progress?.state === 'downloading' || progress?.state === 'installing'
  return (
    <section role="dialog" aria-label="手机端有新版本" className="fixed z-[var(--pi-z-modal)] left-4 right-4 bottom-4 rounded-pi-lg border border-pi-accent/35 bg-pi-bg1 shadow-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-full bg-pi-accent/15 text-pi-accent p-2"><Download className="w-4 h-4" aria-hidden="true" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-pi-text">元枢 App 有新版本 v{latest.version}</h2>
            <button type="button" className="btn-tool !p-1 min-h-11 min-w-11" onClick={later} aria-label="稍后"><X className="w-4 h-4" /></button>
          </div>
          <p className="mt-1 text-xs text-pi-dim">当前 v{bridge()?.version()} · 安装包 {(latest.size / 1048576).toFixed(1)} MB，从你的电脑下载</p>
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className="btn-primary text-sm px-4 min-h-11" disabled={busy} onClick={() => { setProgress(null); bridge()?.install() }}>
              {progress?.state === 'downloading' ? `下载中 ${progress.percent}%` : progress?.state === 'installing' ? '请在系统安装界面确认' : '下载并安装'}
            </button>
            <button type="button" className="btn-tool text-sm px-3 min-h-11" disabled={busy} onClick={later}>这版不提醒</button>
          </div>
          {progress?.state === 'failed' && <p className="mt-2 text-xs text-pi-danger" role="status">{progress.error}</p>}
        </div>
      </div>
    </section>
  )
}
