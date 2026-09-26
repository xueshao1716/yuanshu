// Read-only expansion of the exact snapshot already used by the header orb.
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { PortraitState } from './xiaoyu/PortraitState'
import type { useXiaoyuEmotion } from '../lib/useXiaoyuEmotion'
import type { CompanionAction } from './xiaoyu/companion-state.mjs'
import './xiaoyu/portrait.css'
import './mood-panel.css'

const measurement = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '暂无'
export function MoodPanel({ open, onClose, emotion, action, known }: {
  open: boolean; onClose: () => void; emotion: ReturnType<typeof useXiaoyuEmotion>
  action: CompanionAction; known: boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!open || !dialog.current) return
    const el = dialog.current
    const previous = document.activeElement as HTMLElement | null
    el.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { el.close(); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }) }
  }, [open])
  const { state, meta, status, snapshot } = emotion
  const source = status === 'stale' ? '连接已过期，保留上次观测'
    : status === 'historical' ? '历史情绪，非实时观测'
    : status === 'unavailable' ? '暂无情绪观测' : '全局最近一次对话情绪'
  const rows = [['愉悦度', state?.valence], ['唤醒度', state?.arousal], ['掌控度', state?.dominance], ['强度', state?.intensity]]
  return <dialog ref={dialog} className="companion-mood" aria-label="情绪潮汐与真人形象"
    onCancel={e => { e.preventDefault(); onClose() }} onClick={e => {
      if (e.target !== e.currentTarget) return
      const box = e.currentTarget.getBoundingClientRect()
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose()
    }}>
    {open && <>
      <header><h2>情绪潮汐 · {meta.label}</h2><button type="button" aria-label="关闭形象面板" onClick={onClose} autoFocus><X size={20} /></button></header>
      <PortraitState action={action} emotion={emotion} />
      <p>{source} · 与公仔共用同一份情绪快照</p>
      {snapshot?.observedAt != null && <time dateTime={new Date(snapshot.observedAt).toISOString()}>观测于 {new Date(snapshot.observedAt).toLocaleString()}</time>}
      <dl>{rows.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{measurement(value)}</dd></div>)}</dl>
      <footer>{known ? '动作与公仔同步，依据当前会话运行状态和有效互动决定；全局情绪不覆盖任务事实。' : '任务状态待同步，当前立绘不代表空闲或正在工作。'}</footer>
    </>}
  </dialog>
}
