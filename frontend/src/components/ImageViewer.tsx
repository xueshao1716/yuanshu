import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Download } from 'lucide-react'
import { withFileToken, downloadApiFile } from '../api'

// 图片大图查看（2026-09-18 真机反馈"手机上点开就回不去了"）
//
// 病根：以前点图片是 `window.open(src, '_blank')`。浏览器里会开新标签，返回键能回来；
// 但在**原生壳（Tauri/Capacitor 安卓 WebView）**里，'_blank' 往往被同一个 webview 直接导航过去——
// 没有地址栏、没有返回键、也没有关闭按钮 → 卡在图上出不来。
//
// 这里改成应用内查看器，三条回去的路都给上：
//   ① 右上角关闭按钮（44×44，压在安全区之下）  ② 点背景  ③ 安卓返回键/手势（popstate）
// 另外用 createPortal 挂到 body：ChatArea 外层有 `z-10` 的层叠上下文，
// 直接内联的 z-index 再高也压不过底部 TabBar（真机截图里就是 TabBar 浮在上面）。
export default function ImageViewer({ src, alt = '图片', onClose }: { src: string; alt?: string; onClose: () => void }) {
  const [dragY, setDragY] = useState(0)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState('')
  const pushedRef = useRef(false)
  const startYRef = useRef<number | null>(null)

  // 关闭时把我们压进去的那条历史吃掉，避免"关了之后返回键要按两次"
  const close = () => {
    if (pushedRef.current) {
      pushedRef.current = false
      try { history.back() } catch { onClose() }
      return
    }
    onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  // ① 安卓返回键 / 浏览器后退 → 关查看器（而不是离开页面）
  useEffect(() => {
    try { history.pushState({ __yuanshuImageViewer: 1 }, ''); pushedRef.current = true } catch {}
    const onPop = () => { pushedRef.current = false; onClose() }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [onClose])

  // ② Esc 关闭（桌面）+ 打开期间禁止底层滚动（手机手势会带着页面跑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [])

  const onTouchStart = (e: React.TouchEvent) => { startYRef.current = e.touches[0]?.clientY ?? null }
  const onTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current === null) return
    const dy = (e.touches[0]?.clientY ?? 0) - startYRef.current
    if (dy > 0) setDragY(dy)   // 只跟手向下，向上不跟（避免误拖）
  }
  const onTouchEnd = () => {
    const dy = dragY
    startYRef.current = null
    setDragY(0)
    if (dy > 90) closeRef.current()   // 下滑超过 ~90px 视为"滑掉关闭"
  }

  const save = async () => {
    if (saving) return
    setSaving(true); setNote('')
    try {
      const name = decodeURIComponent((src.split('?')[0].split('/').pop() || 'image.png')).slice(0, 80)
      const path = src.includes('/api/ws/file') && !src.includes('download=') ? `${src}&download=1` : src
      const result = await downloadApiFile(path, name, setNote)
      if (result) setNote(result)
    } catch (e: any) {
      setNote(e?.message === 'Failed to fetch' ? '保存失败：无法获取图片' : (e?.message || '保存失败，请重试'))
    } finally { setSaving(false) }
  }

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      className="image-viewer fixed inset-0 z-[var(--pi-z-viewer)] flex flex-col bg-black/95 select-none"
      style={{ paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)' }}
      onClick={close}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* 顶部：只放关闭按钮，图片区自己去抢剩下的高度 */}
      <div className="relative flex h-12 flex-shrink-0 items-center px-3">
        <button
          type="button"
          aria-label="关闭"
          title="关闭"
          onClick={(e) => { e.stopPropagation(); close() }}
          className="ml-auto flex h-11 w-11 items-center justify-center rounded-full bg-white/12 text-white active:bg-white/25"
        >
          <X className="h-5 w-5" strokeWidth={2} />
        </button>
      </div>
      {/* 图片区：flex-1 + min-h-0，底部控制条永远不会压住图 */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-2" onClick={(e) => e.stopPropagation()}>
        <img
          src={withFileToken(src)}
          alt={alt}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full object-contain transition-transform duration-150"
          style={{ transform: dragY ? `translateY(${dragY}px) scale(${Math.max(0.85, 1 - dragY / 900)})` : undefined }}
        />
      </div>
      {/* 底部：保存原图 + 提示（原生壳里没有"另存为"，所以给一个明确的保存动作） */}
      <div
        className="flex flex-shrink-0 flex-col items-center gap-1.5 px-4 pt-2"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 12px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-white/12 px-4 text-[12.5px] text-white active:bg-white/25"
        >
          <Download className={`h-3.5 w-3.5 ${saving ? 'animate-pulse' : ''}`} />
          {saving ? '保存中…' : '保存原图'}
        </button>
        {note && <div className="text-[11px] text-white/70">{note}</div>}
        <div className="text-[11px] text-white/40">点背景 / 下滑 / 返回键 关闭</div>
      </div>
    </div>
  )

  try { return createPortal(node, document.body) } catch { return node }
}
