// 她的状态带（2026-11-10）：对话页顶栏下方的常驻一条，只放"此刻要一直在眼前"的三件事——
// 关系阶段 / 有没有待批的换代提案 / 有没有处在退化暂停。
// 情绪**不在这条里**：右上角灵珠（情绪潮汐）本来就是情绪的常驻位置，放两处会各说各话。
// 只读、极轻：接口挂了就静默隐藏那一块，状态带绝不能变成错误条。
import useSWR from 'swr'
import { HerApi, fixed2, finite, levelMeta } from '../../lib/her-api'
import { Tag } from '../readout'

export default function HerStatusStrip() {
  const relationship = useSWR('her-relationship', HerApi.relationship, { refreshInterval: 120000, revalidateOnFocus: true })
  const growth = useSWR('her-growth', HerApi.growth, { refreshInterval: 180000, revalidateOnFocus: true })
  const degradation = useSWR('her-degradation', HerApi.degradation, { refreshInterval: 180000, revalidateOnFocus: true })

  const rel = relationship.data
  const stageName = rel?.stage?.name || '关系初建'
  const trust = rel?.trust != null ? `信任 ${fixed2(rel.trust)} · ${stageName}` : ''
  const intimacy = finite(rel?.intimacy)
  const interactions = finite(rel?.interactions)
  const detail = rel
    ? `亲密 ${fixed2(intimacy)} · 已聊 ${interactions} 次${rel.lastAt ? ` · 最近 ${rel.lastAt.slice(0, 10)}` : ''}`
    : '关系状态暂不可用'

  const pending = growth.data?.hasPending === true
  const level = degradation.data?.assessment?.level
  const paused = degradation.data?.gate?.on === true
  const down = level === 'critical' || level === 'degraded'
  const levelInfo = levelMeta(level)
  const alerts = (pending ? 1 : 0) + (paused || down ? 1 : 0)

  // 数据一份都没到、而且没有任何警报时干脆不占这条高度（首屏加载时别画一条空带）。
  if (!rel && !alerts) return null

  return (
    <div
      className={`flex-shrink-0 items-center gap-2 px-4 sm:px-5 h-7 min-h-7 border-b border-pi-border-soft/60 text-[11px] text-pi-dim ${alerts ? 'flex' : 'hidden sm:flex'}`}
      aria-label="她的状态"
    >
      {trust && (
        <a href="#/soul?s=growth" title={detail} className="inline-flex items-center min-w-0 truncate hover:text-pi-text transition-colors">
          <span className="truncate tabular-nums">{trust}</span>
        </a>
      )}
      {pending && (
        <a href="#/soul?s=growth" title="五维满级后生成的换代提案，需要你批准" className="flex-shrink-0">
          <Tag tone="warn">换代提案待批</Tag>
        </a>
      )}
      {paused ? (
        <a href="#/health" title={degradation.data?.gate?.reason || '退化自评挂了暂停闸'} className="flex-shrink-0">
          <Tag tone="danger">退化暂停</Tag>
        </a>
      ) : down ? (
        <a href="#/health" title={`退化自评：${levelInfo.label}`} className="flex-shrink-0">
          <Tag tone={levelInfo.tone === 'danger' ? 'danger' : 'warn'}>{level === 'critical' ? '严重退化' : '状态下滑'}</Tag>
        </a>
      ) : null}
      <a href="#/health" className="ml-auto hidden md:inline-flex flex-shrink-0 text-pi-dim2 hover:text-pi-text transition-colors">运行健康</a>
    </div>
  )
}
