import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react'
import { withFileToken, downloadApiFile } from '../api'
import { mediaFilename, mediaSwipe, type ChatMedia } from '../lib/chat-media'

export default function ImageViewer({ src, alt = '图片', items, initialIndex = 0, onClose }: {
  src: string; alt?: string; items?: ChatMedia[]; initialIndex?: number; onClose: () => void
}) {
  const media = items?.length ? items : [{ src, kind: 'image' as const, name: mediaFilename(src, 'image') }]
  const [index, setIndex] = useState(Math.min(initialIndex, media.length - 1))
  const current = media[index]
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const touchRef = useRef<{ x: number; y: number } | null>(null)
  const historyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = () => {
    if (historyRef.current) { historyRef.current = false; history.back() }
    else onCloseRef.current()
  }
  const navigate = (delta: number) => {
    if (saving) return
    setIndex(value => Math.max(0, Math.min(media.length - 1, value + delta)))
    setNote(''); setError(false); setLoadError(false)
  }
  const actions = useRef({ close, navigate })
  actions.current = { close, navigate }

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    const marker = `media-${Date.now()}-${Math.random()}`
    try { history.pushState({ ...history.state, __yuanshuImageViewer: marker }, ''); historyRef.current = true } catch { /* Back is optional. */ }
    const onPop = () => { historyRef.current = false; onCloseRef.current() }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); actions.current.close() }
      if (!(event.target instanceof HTMLVideoElement) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault(); actions.current.navigate(event.key === 'ArrowLeft' ? -1 : 1)
      }
      if (event.key === 'Tab') {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], video[controls]') || [])
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()
    return () => {
      window.removeEventListener('popstate', onPop); window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
      if (historyRef.current && history.state?.__yuanshuImageViewer === marker) {
        const state = { ...history.state }; delete state.__yuanshuImageViewer; history.replaceState(state, '')
      }
    }
  }, [])

  const save = async () => {
    if (saving) return
    setSaving(true); setNote(''); setError(false)
    try { setNote(await downloadApiFile(current.src, current.name, setNote)) }
    catch (e: any) { setError(true); setNote(e?.message === 'Failed to fetch' ? '无法获取原文件，请检查网络后重试' : e?.message || '保存失败，请重试') }
    finally { setSaving(false) }
  }
  const button = 'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-white/15 px-3 text-sm text-white hover:bg-white/25 active:bg-white/30 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
  const node = <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="会话素材查看" className="image-viewer fixed inset-0 z-[var(--pi-z-viewer)] flex flex-col bg-black/95 text-white"
    style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)' }} onClick={e => { if (e.target === e.currentTarget) close() }}>
    <div className="flex h-14 shrink-0 items-center gap-3 px-3">
      <span className="min-w-0 flex-1 truncate text-sm" title={current.name}>{current.name}</span>
      <span className="shrink-0 text-sm text-white/80 tabular-nums" aria-live="polite">{index + 1} / {media.length}</span>
      <button ref={closeButtonRef} type="button" className={button} aria-label="关闭" onClick={close}><X className="h-5 w-5" /></button>
    </div>
    <div className="flex min-h-0 flex-1 items-center justify-center px-2" style={{ touchAction: 'pinch-zoom' }}
      onClick={e => { if (e.target === e.currentTarget) close() }}
      onTouchStart={e => {
        if (e.touches.length !== 1) { touchRef.current = null; return }
        // Reserve the native control strip for seeking, volume and fullscreen.
        if (e.target instanceof HTMLVideoElement && e.touches[0].clientY >= e.target.getBoundingClientRect().bottom - 56) { touchRef.current = null; return }
        touchRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      }}
      onTouchCancel={() => { touchRef.current = null }}
      onTouchEnd={e => {
        const start = touchRef.current; touchRef.current = null
        if (!start || e.touches.length || !e.changedTouches[0]) return
        const action = mediaSwipe(e.changedTouches[0].clientX - start.x, e.changedTouches[0].clientY - start.y)
        if (action === 'close') close()
        else if (action) navigate(action === 'next' ? 1 : -1)
      }}>
      {loadError ? <p role="alert" className="p-4 text-sm text-white/80">素材加载失败，可尝试保存原文件或切换下一项。</p> : current.kind === 'video'
        ? <video key={current.src} controls playsInline preload="metadata" src={withFileToken(current.src)} onError={() => setLoadError(true)} className="max-h-full max-w-full" />
        : <img key={current.src} src={withFileToken(current.src)} alt={current.name || alt} draggable={false} onError={() => setLoadError(true)} className="max-h-full max-w-full object-contain" />}
    </div>
    <div className="flex shrink-0 flex-col items-center gap-2 px-4 pt-3" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}>
      <div className="flex w-full max-w-md items-center justify-between gap-3">
        <button type="button" className={button} aria-label="上一项素材" disabled={index === 0 || saving} onClick={() => navigate(-1)}><ChevronLeft className="h-5 w-5" /></button>
        <button type="button" className={button} disabled={saving} onClick={save}><Download className="h-4 w-4" />{saving ? '保存中…' : current.kind === 'video' ? '保存视频' : '保存原图'}</button>
        <button type="button" className={button} aria-label="下一项素材" disabled={index === media.length - 1 || saving} onClick={() => navigate(1)}><ChevronRight className="h-5 w-5" /></button>
      </div>
      {note && <p role={error ? 'alert' : 'status'} className="max-w-lg break-words text-center text-sm text-white/90">{note}</p>}
      {note && !saving && <a className="inline-flex min-h-11 items-center text-sm text-white underline underline-offset-4" href={withFileToken(current.src)} target="_blank" rel="noopener noreferrer" download={current.name}>打开原文件保存</a>}
      <p className="text-center text-sm text-white/70">{current.kind === 'video' ? '画面左右滑动 / 按钮切换 · 返回键关闭' : '左右滑动 / 方向键切换 · 下滑关闭'}</p>
    </div>
  </div>
  return createPortal(node, document.body)
}
