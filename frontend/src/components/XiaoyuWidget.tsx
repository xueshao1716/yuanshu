import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { readPreference, savePreference, useWidgetMotion } from './xiaoyu/useWidgetMotion'
import { useWidgetStatus } from './xiaoyu/useWidgetStatus'
import type { useCompanion } from './xiaoyu/useCompanion'
import { ACTION_LABELS } from './xiaoyu/companion-state.mjs'
import { panelPosition } from './xiaoyu/widget-state.mjs'
import { PortraitState } from './xiaoyu/PortraitState'
import { WidgetPanel } from './xiaoyu/WidgetPanel'
import './xiaoyu/widget.css'
import './xiaoyu/portrait.css'

export default function XiaoyuWidget({ companion, hidden, setHidden }: {
  companion: ReturnType<typeof useCompanion>; hidden: boolean; setHidden: (hidden: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [large, setLarge] = useState(() => readPreference('yuanshu_companion_large') === 'true')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const status = useWidgetStatus()
  const motion = useWidgetMotion(true)
  useEffect(() => { savePreference('xiaoyu_skin', 'portrait') }, [])
  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])
  const close = () => { setOpen(false); button.current?.focus() }
  const hide = () => { setHidden(true); setOpen(false) }
  const resize = () => setLarge(v => { savePreference('yuanshu_companion_large', String(!v)); return !v })
  if (hidden) return createPortal(<button type="button" className="companion-restore" onClick={() => {
    setHidden(false)
  }} aria-label="显示真人公仔">显示公仔</button>, document.body)
  return createPortal(<div ref={root} className="xiaoyu-companion" style={{ left: motion.position.x, top: motion.position.y }}
    data-reduced-motion={motion.reduced} data-large={large}>
    <button ref={button} type="button" className="xiaoyu-widget" data-skin="portrait" data-dragged={motion.dragged}
      aria-label={`${status.name} · ${companion.facts?.known ? ACTION_LABELS[companion.action] : '状态待同步'} · 打开陪伴面板`}
      aria-expanded={open} aria-controls={open ? 'xiaoyu-panel' : undefined} title="点击互动，拖动调整位置"
      onClick={e => { if (motion.consumeDrag() && e.detail !== 0) return; setOpen(v => !v) }} {...motion.handlers}>
      <PortraitState action={companion.action} emotion={companion.emotion} compact />
      <span className="xiaoyu-name">{companion.pending ? '正在回应…' : companion.facts?.known ? ACTION_LABELS[companion.action] : '状态待同步'}</span>
    </button>
    {!open && !companion.dnd && companion.decision?.shouldInterrupt && companion.decision.utterance &&
      <aside className="companion-bubble" style={panelPosition(motion.position, motion.view, 200)} aria-live="polite"><p>{companion.decision.utterance}</p>
        <button type="button" onClick={companion.dismiss} aria-label="关闭互动气泡">关闭</button></aside>}
    {open && <WidgetPanel motion={motion} status={status} companion={companion} close={close} hide={hide} resize={resize} large={large} />}
  </div>, document.body)
}
