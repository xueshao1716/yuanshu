import { useLayoutEffect, useRef, useState } from 'react'
import { X, Download, RotateCcw, EyeOff } from 'lucide-react'
import { panelPosition } from './widget-state.mjs'
import { portraitFor } from './companion-state.mjs'
import type { useWidgetMotion } from './useWidgetMotion'
import type { useWidgetStatus } from './useWidgetStatus'
import type { useCompanion } from './useCompanion'
import { PortraitState } from './PortraitState'
import { queueDraft } from './companion-draft.mjs'

type Props = {
  close: () => void; hide: () => void; resize: () => void; large: boolean
  motion: ReturnType<typeof useWidgetMotion>; status: ReturnType<typeof useWidgetStatus>
  companion: ReturnType<typeof useCompanion>
}
export function WidgetPanel({ motion, status, companion: c, close, hide, resize, large }: Props) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [height, setHeight] = useState(650)
  const [text, setText] = useState('')
  const [handoff, setHandoff] = useState('')
  const position = panelPosition(motion.position, motion.view, height)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setHeight(el.scrollHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    closeRef.current?.focus({ preventScroll: true })
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { setText(''); setHandoff('') }, [c.sessionId])
  const factLabel = !c.facts?.known ? '当前会话状态暂不可用' : c.facts.currentBusy
    ? c.facts.reading ? '当前会话正在读取资料' : '当前会话正在执行任务'
    : c.facts.otherBusy > 0 ? `当前会话空闲 · 后台 ${c.facts.otherBusy} 个任务运行中` : '当前会话暂无运行任务'
  const emotionLabel = c.emotion.status === 'stale' ? '连接已过期，保留上次观测' : c.emotion.status === 'unavailable'
    ? '暂无情绪观测' : c.emotion.status === 'historical' ? '历史情绪，非实时观测' : '全局最近一次对话情绪'
  const disabled = c.pending || !c.facts?.known
  return <section ref={ref} id="xiaoyu-panel" className="xiaoyu-panel companion-panel" style={position} aria-label="真人陪伴面板">
    <header className="xiaoyu-panel-head"><div><h2>{status.name}</h2><p>{factLabel}</p></div>
      <button ref={closeRef} type="button" onClick={close} aria-label="关闭陪伴面板"><X size={18} /></button></header>
    <PortraitState action={c.action} emotion={c.emotion} />
    <section className="companion-emotion" aria-label="与情绪潮汐同步">
      <strong>情绪潮汐 · {c.emotion.meta.label}</strong><p>{emotionLabel}</p>
      {c.emotion.snapshot?.observedAt && <time dateTime={new Date(c.emotion.snapshot.observedAt).toISOString()}>
        观测于 {new Date(c.emotion.snapshot.observedAt).toLocaleString()}</time>}
    </section>
    <div className="companion-response" role="status" aria-live="polite">
      {c.pending ? <p>正在结合当前会话回应…</p> : c.feedback ? <p>{c.feedback}</p> : c.decision ? <>
        <p>{c.decision.utterance || '本次仅调整呈现状态，没有追加话语。'}</p>
        <details><summary>这次呈现的依据</summary><p>{c.decision.reason}</p>
          <p>实际模型：{c.decision.actualModel.provider} / {c.decision.actualModel.id}</p></details>
      </> : <p>你可以问问她正在忙什么；没有模型回应时不播放预设台词。</p>}
    </div>
    <div className="companion-actions">
      <button type="button" disabled={disabled} onClick={() => void c.interact('tap')}>打个招呼</button>
      <button type="button" disabled={disabled} onClick={() => void c.interact('busy')}>在忙什么</button>
      <button type="button" disabled={disabled} onClick={() => void c.interact('rest')}>休息一下</button>
    </div>
    <form onSubmit={e => { e.preventDefault(); if (text.trim() && !disabled) void c.interact('text', text.trim()) }}>
      <label htmlFor="companion-input">说句话</label>
      <textarea id="companion-input" rows={2} maxLength={500} value={text} onChange={e => { setText(e.target.value); setHandoff('') }} placeholder="这里仅作短互动，不执行任务" />
      <div className="companion-actions"><button type="submit" disabled={disabled || !text.trim()}>回应我</button>
        <button type="button" disabled={!c.sessionId || !text.trim()} onClick={() => {
          if (!queueDraft(sessionStorage, c.sessionId, text.trim())) { setHandoff('暂存失败，请手动复制文字到对话。'); return }
          window.dispatchEvent(new Event('yuanshu-companion-draft'))
          window.location.hash = '/chat'
          setHandoff('已带到当前会话草稿，检查后由你发送。')
        }}>带到对话</button></div>
      {handoff && <p role="status">{handoff}</p>}
    </form>
    <label className="companion-dnd"><input type="checkbox" checked={c.dnd} disabled={!c.preferencesReady}
      onChange={e => void c.setDnd(e.target.checked)} />免打扰：不主动互动，不影响任务</label>
    <div className="xiaoyu-tools"><button type="button" onClick={motion.reset}><RotateCcw size={15} />归位</button>
      <button type="button" aria-pressed={large} onClick={resize}>{large ? '标准大小' : '放大立绘'}</button>
      <button type="button" onClick={hide}><EyeOff size={15} />隐藏</button></div>
    <a href={portraitFor(c.action).src} download><Download size={15} />下载当前立绘</a>
    <footer className="xiaoyu-version"><span>元枢 {status.version ? `v${status.version}` : '版本读取中'}</span>
      <button type="button" disabled={status.checking} onClick={status.checkUpdate}>检查更新</button></footer>
    {status.update && <p className="xiaoyu-update" role="status">{status.update}</p>}
  </section>
}
