import { useLayoutEffect, useRef, useState } from 'react'
import { X, Download, RotateCcw } from 'lucide-react'
import { SKINS, canRoam, imageForSkin, panelPosition } from './widget-state.mjs'
import type { useWidgetMotion } from './useWidgetMotion'
import type { useWidgetStatus } from './useWidgetStatus'
import { WidgetStudio } from './WidgetStudio'
import { PortraitPreview } from './PortraitPreview'

type Props = {
  skin: string; chooseSkin: (skin: string) => void; close: () => void
  scene: string; chooseScene: (scene: string) => void
  motion: ReturnType<typeof useWidgetMotion>; status: ReturnType<typeof useWidgetStatus>
}
export function WidgetPanel({ skin, chooseSkin, scene, chooseScene, motion, status, close }: Props) {
  const ref = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [height, setHeight] = useState(400)
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
  const selected = SKINS.find(s => s.id === skin)!
  return <section ref={ref} id="xiaoyu-panel" className="xiaoyu-panel" style={position} aria-label="公仔设置">
    <header className="xiaoyu-panel-head">
      <div><h2>{status.name}</h2><p>{status.busy === null ? '任务状态暂不可用' : status.busy > 0 ? `${status.busy} 个任务进行中` : '在这里，陪你做事。'}</p></div>
      <button ref={closeRef} type="button" onClick={close} aria-label="关闭公仔设置"><X size={18} /></button>
    </header>
    {skin === 'portrait' ? <PortraitPreview /> : <WidgetStudio skin={skin} name={status.name} scene={scene} chooseScene={chooseScene} />}
    <fieldset className="xiaoyu-appearance"><legend>外观</legend>
      <div className="xiaoyu-skin-options">{SKINS.map(s => <button key={s.id} type="button"
        aria-pressed={skin === s.id} onClick={() => chooseSkin(s.id)}>
        <span>{s.label}</span><small>{s.detail}</small>
      </button>)}</div>
    </fieldset>
    <fieldset><legend>活动方式</legend>
      <div className="xiaoyu-mode-options">
        <button type="button" aria-pressed={!canRoam(skin) || motion.mode === 'corner'} onClick={() => motion.setMode('corner')}>原地陪伴</button>
        <button type="button" disabled={!canRoam(skin)} aria-pressed={canRoam(skin) && motion.mode === 'roam'} onClick={() => motion.setMode('roam')}>自由活动</button>
      </div>
      <p className="xiaoyu-hint">{!canRoam(skin) ? '坐姿形象保持原地，可拖动摆放；其他皮肤的活动偏好会保留。' : motion.reduced ? '已跟随系统减少动态效果，公仔保持静止。' : motion.mode === 'roam' ? '关闭面板后轻缓移动，停留时可拖动。' : '拖动公仔调整位置，会记住你的摆放。'}</p>
    </fieldset>
    <div className="xiaoyu-tools">
      <button type="button" onClick={motion.reset}><RotateCcw size={15} />回到角落</button>
      <a href={imageForSkin(skin)} download aria-label={`下载${selected.label}立绘`}><Download size={15} />下载立绘</a>
    </div>
    <footer className="xiaoyu-version">
      <span>元枢 {status.version ? `v${status.version}` : '版本读取中'}</span>
      <button type="button" disabled={status.checking} onClick={status.checkUpdate}>检查更新</button>
    </footer>
    {status.update && <p className="xiaoyu-update" role="status">{status.update}</p>}
  </section>
}
