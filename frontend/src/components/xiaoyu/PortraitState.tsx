import { useEffect, useState, type CSSProperties } from 'react'
import { vadVisual } from '../../lib/emotion'
import { ACTION_LABELS, portraitFor, type CompanionAction } from './companion-state.mjs'
import { imageForSkin, normalizeSkin } from './widget-state.mjs'
import { portraitAssetUrl } from './portrait-asset.mjs'
import { useLiveliness } from './useLiveliness'
export function PortraitState({ action, emotion, compact = false, skin = 'portrait' }: { action: CompanionAction; emotion: any; compact?: boolean; skin?: string }) {
  const selectedSkin = normalizeSkin(skin)
  // 2026-11-06：让公仔"活"起来——视线跟随 / 眨眼 / 呼吸微摆 / 偶发小动作
  const live = useLiveliness(action)
  const shownAction = (live.gesture || action) as CompanionAction
  const base = portraitFor(action)
  const asset = selectedSkin === 'portrait' ? base : { src: imageForSkin(selectedSkin, action), missing: false }
  const shownAsset = live.gesture && selectedSkin === 'portrait' ? portraitFor(live.gesture) : asset
  const imageSrc = portraitAssetUrl(shownAsset.src)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [imageSrc])
  const visual = emotion.state && emotion.status !== 'stale' ? vadVisual(emotion.state) : null
  const style = {
    '--live-tilt-x': live.tiltX.toFixed(3),
    '--live-tilt-y': live.tiltY.toFixed(3),
    '--live-bump': String(live.bump),
    '--portrait-hue': visual?.hue ?? 0, '--portrait-glow': visual?.glow ?? 0,
    '--portrait-period': `${visual ? 1 / visual.tempo : 5}s` } as CSSProperties
  const Tag = compact ? 'span' : 'figure'
  return <Tag className={`companion-portrait${compact ? ' is-compact' : ''}`} style={style} data-action={base} data-shown-action={shownAction} data-live="1" data-blinking={live.blinking ? "1" : "0"} data-shown-action={shownAction} data-live="1" data-blinking={live.blinking ? "1" : "0"} data-skin={selectedSkin}>
    {failed ? <span className="xiaoyu-image-fallback">立绘暂不可用</span> : <img src={imageSrc}
      alt={`元枢 AI 真人形象 · ${selectedSkin === 'portrait' ? ACTION_LABELS[action] : selectedSkin === 'portrait-life' ? `${ACTION_LABELS[action]} · 生活状态组` : '当前换装'}`} draggable={false} onError={() => setFailed(true)} />}
    {!compact && <figcaption><strong>{ACTION_LABELS[shownAction]}</strong>
      {asset.missing && <span>该姿态素材待补，暂用基础立绘</span>}
      <span>真人形象 · 状态随情绪变化</span>
    </figcaption>}
  </Tag>
}
