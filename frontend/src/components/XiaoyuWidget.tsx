import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { imageForSkin, normalizeSkin } from './xiaoyu/widget-state.mjs'
import { readPreference, savePreference, useWidgetMotion } from './xiaoyu/useWidgetMotion'
import { useWidgetStatus } from './xiaoyu/useWidgetStatus'
import { WidgetPanel } from './xiaoyu/WidgetPanel'
import './xiaoyu/widget.css'

export default function XiaoyuWidget() {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [skin, setSkin] = useState(() => normalizeSkin(readPreference('xiaoyu_skin')))
  const [greeting, setGreeting] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const status = useWidgetStatus()
  const motion = useWidgetMotion(open || hover)
  const frame = greeting ? 'happy' : status.busy ? 'focused' : 'open'
  const image = imageForSkin(skin, frame)
  const animated = skin === 'puppet' || skin === 'doll-puppet'

  useEffect(() => { setImageFailed(false) }, [image])
  useEffect(() => {
    if (!greeting) return
    const timer = setTimeout(() => setGreeting(false), 650)
    return () => clearTimeout(timer)
  }, [greeting])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const close = () => { setOpen(false); button.current?.focus() }
  const chooseSkin = (next: string) => { setSkin(next); savePreference('xiaoyu_skin', next) }

  return createPortal(
    <div ref={root} className="xiaoyu-companion" style={{ left: motion.position.x, top: motion.position.y }}
      data-reduced-motion={motion.reduced}>
      <button ref={button} type="button" className="xiaoyu-widget" data-skin={skin} data-mode={motion.mode}
        data-tasks={status.busy ?? 'unknown'} data-dragged={motion.dragged} aria-label={`${status.name} · 公仔设置`}
        aria-expanded={open} aria-controls={open ? 'xiaoyu-panel' : undefined}
        title="点击打开设置，拖动调整位置"
        onClick={(e) => { if (motion.consumeDrag() && e.detail !== 0) return; setOpen(v => !v); setGreeting(true) }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} {...motion.handlers}>
        <span className="xiaoyu-facing" style={{ transform: `scaleX(${motion.face})` }}>
          <span className="xiaoyu-figure" data-animated={animated} data-walking={motion.walking}
            data-greeting={greeting} data-paused={open || hover || motion.dragged}>
            {imageFailed ? <span className="xiaoyu-image-fallback">{status.name}</span>
              : <img src={image} alt="" draggable={false} onError={() => setImageFailed(true)} />}
          </span>
        </span>
        <span className="xiaoyu-name">{status.name}</span>
      </button>
      {open && <WidgetPanel skin={skin} chooseSkin={chooseSkin} motion={motion} status={status} close={close} />}
    </div>, document.body,
  )
}
