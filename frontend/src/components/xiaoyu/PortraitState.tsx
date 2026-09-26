import { useEffect, useState, type CSSProperties } from 'react'
import { vadVisual } from '../../lib/emotion'
import { ACTION_LABELS, portraitFor, type CompanionAction } from './companion-state.mjs'
export function PortraitState({ action, emotion, compact = false }: { action: CompanionAction; emotion: any; compact?: boolean }) {
  const asset = portraitFor(action)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [asset.src])
  const visual = emotion.state && emotion.status !== 'stale' ? vadVisual(emotion.state) : null
  const style = { '--portrait-hue': visual?.hue ?? 0, '--portrait-glow': visual?.glow ?? 0,
    '--portrait-period': `${visual ? 1 / visual.tempo : 5}s` } as CSSProperties
  const Tag = compact ? 'span' : 'figure'
  return <Tag className={`companion-portrait${compact ? ' is-compact' : ''}`} style={style} data-action={action}>
    {failed ? <span className="xiaoyu-image-fallback">立绘暂不可用</span> : <img src={asset.src}
      alt={`元枢 AI 真人形象${asset.missing ? ' · 基础立绘' : ''}`} draggable={false} onError={() => setFailed(true)} />}
    {!compact && <figcaption><strong>{ACTION_LABELS[action]}</strong>
      {asset.missing && <span>该姿态素材待补，暂用基础立绘</span>}
      <span>AI 生成虚构成人形象 · 休息为呈现状态</span>
    </figcaption>}
  </Tag>
}
