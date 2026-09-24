import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Copy, ExternalLink, Globe2, Loader2, RotateCw } from 'lucide-react'
import { copyText } from '../lib/clipboard'

function resolveUrl(value: string): string | null {
  const raw = value.trim()
  if (!raw) return null
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`
  try {
    const parsed = new URL(candidate, typeof window !== 'undefined' ? window.location.href : undefined)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null
  } catch { return null }
}

export default function BrowserPanel({ open, initialUrl, onClose }: { open: boolean; initialUrl: string; onClose: () => void }) {
  const [address, setAddress] = useState('')
  const [currentUrl, setCurrentUrl] = useState('')
  const [frameKey, setFrameKey] = useState(0)
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadProblem, setLoadProblem] = useState('')
  const loadTimer = useRef<number | undefined>(undefined)
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const onCloseRef = useRef(onClose)
  const historyPushedRef = useRef(false)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    returnFocusRef.current = document.activeElement as HTMLElement
    setNotice('')
    const next = resolveUrl(initialUrl)
    if (next) {
      setAddress(next); setCurrentUrl(next); setHistory([next]); setHistoryIndex(0); setLoading(true)
    } else {
      setAddress(''); setCurrentUrl(''); setHistory([]); setHistoryIndex(-1); setLoading(false)
    }
    requestAnimationFrame(() => (next ? inputRef.current : closeRef.current)?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closePanel() }
      if (event.key === 'Tab' && !event.shiftKey && document.activeElement === closeRef.current) {
        event.preventDefault(); inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      returnFocusRef.current?.focus()
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    }
  }, [open, initialUrl])

  useEffect(() => {
    setLoadProblem('')
    if (!open || !currentUrl) { setLoading(false); return }
    setLoading(true)
    loadTimer.current = window.setTimeout(() => {
      setLoading(false)
      setLoadProblem('页面加载较慢，或网站不允许内嵌显示。可在当前窗口打开，或复制地址。')
    }, 15000)
    return () => window.clearTimeout(loadTimer.current)
  }, [open, currentUrl, frameKey])

  const frameSettled = (failed = false) => {
    window.clearTimeout(loadTimer.current)
    setLoading(false)
    // iframe load is not proof that cross-origin content or CSP succeeded.
    setLoadProblem(failed ? '未能加载内嵌页面，请在当前窗口打开或复制地址。' : '')
  }

  // 把浏览器面板挂到一条临时历史记录上：手机返回键/浏览器后退先收起面板，
  // 不会把用户直接带离元枢。显式关闭时吃掉这条临时记录，避免返回键要按两次。
  useEffect(() => {
    if (!open) return
    try {
      window.history.pushState({ __yuanshuBrowserPanel: 1 }, '')
      historyPushedRef.current = true
    } catch {}
    const onPopState = () => {
      historyPushedRef.current = false
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [open])

  const announce = (message: string) => {
    setNotice(message)
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 2600)
  }

  const navigate = (value = address) => {
    const next = resolveUrl(value)
    if (!next) { announce('只支持 http(s) 链接'); return }
    setAddress(next); setCurrentUrl(next); setFrameKey(key => key + 1); setLoading(true)
    setHistory(items => {
      const nextItems = [...items.slice(0, historyIndex + 1), next]
      setHistoryIndex(nextItems.length - 1)
      return nextItems
    })
  }

  const moveHistory = (delta: number) => {
    const nextIndex = historyIndex + delta
    const next = history[nextIndex]
    if (!next) return
    setHistoryIndex(nextIndex); setAddress(next); setCurrentUrl(next); setFrameKey(key => key + 1); setLoading(true)
  }

  function closePanel() {
    if (historyPushedRef.current) {
      historyPushedRef.current = false
      try { window.history.go(-1) } catch {}
    }
    onCloseRef.current()
  }
  // 外部页面改在当前标签打开，保留浏览器历史，这样系统浏览器的后退键
  // 一定能回到元枢工作台；新开标签会把用户带到一个没有返回入口的孤立页面。
  const openSystem = () => { if (currentUrl) window.location.assign(currentUrl) }
  const copyCurrent = async () => announce(await copyText(currentUrl) ? '地址已复制' : '复制失败，请长按地址栏选择复制')

  if (!open) return null
  return <div className="browser-panel-layer" role="presentation">
    <aside className="browser-panel" role="dialog" aria-modal="true" aria-label="内置浏览器">
      <header className="browser-panel-header">
        <div className="browser-panel-title"><Globe2 className="h-4 w-4 text-pi-accent" /><span>内置浏览器</span></div>
        <button ref={closeRef} type="button" className="browser-return-button touch-hit" onClick={closePanel} aria-label="回到元枢工作台" title="回到元枢工作台"><ArrowLeft className="h-4 w-4" /><span>回到工作台</span></button>
      </header>
      <div className="browser-toolbar">
        <button type="button" className="btn-tool touch-hit" aria-label="后退" title="后退" disabled={historyIndex <= 0} onClick={() => moveHistory(-1)}><ArrowLeft className="h-4 w-4" /></button>
        <button type="button" className="btn-tool touch-hit" aria-label="前进" title="前进" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => moveHistory(1)}><ArrowRight className="h-4 w-4" /></button>
        <button type="button" className="btn-tool touch-hit" aria-label="刷新页面" title="刷新" disabled={!currentUrl} onClick={() => { setFrameKey(key => key + 1); setLoading(true) }}><RotateCw className="h-4 w-4" /></button>
        <form className="browser-address-form" onSubmit={event => { event.preventDefault(); navigate() }}>
          <input ref={inputRef} value={address} onChange={event => setAddress(event.target.value)} aria-label="浏览器地址" placeholder="输入网址，例如 https://example.com" spellCheck={false} />
        </form>
        <button type="button" className="btn-tool touch-hit" aria-label="复制当前地址" title="复制当前地址" disabled={!currentUrl} onClick={() => void copyCurrent()}><Copy className="h-4 w-4" /></button>
        <button type="button" className="btn-tool touch-hit" aria-label="在当前窗口打开" title="在当前窗口打开，之后可用浏览器后退返回" disabled={!currentUrl} onClick={openSystem}><ExternalLink className="h-4 w-4" /></button>
      </div>
      {notice && <div className="browser-notice" role="status">{notice}</div>}
      {loadProblem && <div className="browser-notice" role="alert">
        <p>{loadProblem}</p>
        <button type="button" className="btn-tool touch-hit" onClick={openSystem}>在当前窗口打开</button>
        <button type="button" className="btn-tool touch-hit" onClick={() => void copyCurrent()}>复制地址</button>
      </div>}
      <div className="browser-frame-wrap">
        {loading && <div className="browser-loading" role="status"><Loader2 className="h-4 w-4 animate-spin" />正在加载页面…</div>}
        {currentUrl ? <>
          <iframe key={frameKey} src={currentUrl} title="内置浏览器页面" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts" referrerPolicy="strict-origin-when-cross-origin" onLoad={() => frameSettled()} onError={() => frameSettled(true)} />
          <p className="browser-hint">部分网站会禁止内嵌显示；页面空白时请点右上角“在当前窗口打开”，之后用浏览器后退返回工作台。</p>
        </> : <div className="browser-empty"><Globe2 className="h-10 w-10" /><p>从消息里的链接点“打开”，或在上方输入网址。</p></div>}
      </div>
    </aside>
  </div>
}
