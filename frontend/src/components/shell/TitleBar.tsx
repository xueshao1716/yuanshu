import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// 元枢壳自绘标题栏：仅在 Tauri WebView 内渲染（浏览器里 window.__TAURI__ 不存在 → 返回 null，网页版零影响）
// macOS 风格红黄绿窗口钮；窗口控制依赖壳侧 capability（remote: 127.0.0.1:8787）授权的 core:window 权限
export default function TitleBar() {
  const [win, setWin] = useState<any>(null)
  const [maxed, setMaxed] = useState(false)

  useEffect(() => {
    const t = (window as any).__TAURI__
    const w = t?.window?.getCurrentWindow?.()
    if (!w) return
    setWin(w)
    const sync = () => { w.isMaximized?.().then((v: boolean) => setMaxed(!!v)).catch(() => {}) }
    sync()
    let un: any
    try {
      w.onResized?.(() => sync()).then((fn: any) => { un = fn }).catch(() => {})
    } catch {}
    return () => { try { un?.() } catch {} }
  }, [])

  if (!win) return null

  const macDot = (color: string, sym: string, label: string, onClick: () => void): ReactNode => (
    <button aria-label={label} title={label} onClick={onClick}
      className="w-6 h-6 flex items-center justify-center group">
      <span className="w-3 h-3 rounded-full flex items-center justify-center transition-transform group-hover:scale-110"
        style={{ background: color, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,.12)' }}>
        <span className="opacity-0 group-hover:opacity-100 text-[11px] leading-none font-bold text-black/55 select-none">{sym}</span>
      </span>
    </button>
  )

  return (
    <div className="h-9 flex items-center flex-shrink-0 relative z-[var(--pi-z-topbar)] bg-pi-bg2 border-b border-pi-border select-none">
      <div data-tauri-drag-region className="flex-1 self-stretch flex items-center pl-3 gap-2 min-w-0">
        <span className="text-pi-accent text-xs font-bold tracking-tight pointer-events-none">◈ 元枢</span>
        <span className="text-pi-dim2 text-[11px] hidden sm:inline pointer-events-none">个人智能系统</span>
      </div>
      <div className="flex items-center gap-1 pr-3">
        {macDot('#ff5f57', '×', '关闭', () => win.close?.())}
        {macDot('#febc2e', '−', '最小化', () => win.minimize?.())}
        {macDot('#28c840', maxed ? '⤡' : '⤢', maxed ? '还原' : '最大化', () => win.toggleMaximize?.())}
      </div>
    </div>
  )
}
