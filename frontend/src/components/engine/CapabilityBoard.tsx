// 能力总览（2026-11-19）：技能、内置工具、MCP、插件工具包放在一处，按热度分组。
// 热度来自 /api/usage-heat（engine/usage-heat.mjs）：近 30 天次数 × 新近度 × 成功率。
// 热档工具每轮直接下发（额外最多 hotToolCap 个），热档技能排前、匹配加分；
// 钉住 = 始终算热，收起 = 不主动给模型（工具仍可 request_tool 取回）。
import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Flame, Sun, Snowflake, Moon, Search, Puzzle, Wrench, Plug, Package, Pin, PinOff, EyeOff, Eye, Plug2 } from 'lucide-react'
import { EngineApi, HeatApi, SkillsApi, type HeatItem, type HeatTier } from '../../api'
import McpPanel from '../panels/McpPanel'

type Kind = 'skill' | 'builtin' | 'mcp' | 'toolpack'
type Entry = { key: string; kind: Kind; heatKind: 'tool' | 'skill'; name: string; title: string; description: string; source?: string; folded?: boolean; heat?: HeatItem; tier: HeatTier }

const KIND_META: Record<Kind, { label: string; icon: typeof Puzzle }> = {
  skill: { label: '技能', icon: Puzzle },
  builtin: { label: '内置工具', icon: Wrench },
  mcp: { label: 'MCP', icon: Plug },
  toolpack: { label: '插件工具包', icon: Package },
}
const TIER_META: Record<HeatTier, { label: string; hint: string; icon: typeof Flame; color: string }> = {
  hot: { label: '常用', hint: '近期反复在用，每轮直接带上', icon: Flame, color: '#f97316' },
  warm: { label: '偶尔用', hint: '用过几次，热度在保持', icon: Sun, color: '#eab308' },
  cold: { label: '渐冷', hint: '有一阵没用了', icon: Snowflake, color: '#38bdf8' },
  idle: { label: '还没用过', hint: '装着但从没被调用', icon: Moon, color: 'var(--pi-dim2)' },
}
const TIERS: HeatTier[] = ['hot', 'warm', 'cold', 'idle']

const ago = (iso: string | null) => {
  if (!iso) return '从未'
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000)
  if (m < 60) return `${Math.round(m)} 分钟前`
  if (m < 1440) return `${Math.round(m / 60)} 小时前`
  return `${Math.round(m / 1440)} 天前`
}

function Spark({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(1, ...data)
  return <span className="cap-spark" aria-hidden="true">
    {data.map((v, i) => <i key={i} style={{ height: `${v ? 18 + (v / max) * 82 : 6}%`, background: v ? color : undefined }} />)}
  </span>
}

export default function CapabilityBoard({ openMcp = false }: { openMcp?: boolean }) {
  const skills = useSWR('skills', () => SkillsApi.list())
  const tools = useSWR('engine-tools', () => EngineApi.tools(), { refreshInterval: 60000 })
  const heat = useSWR('usage-heat', () => HeatApi.get(), { refreshInterval: 60000 })
  const [kind, setKind] = useState<'all' | Kind>('all')
  const [kw, setKw] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const entries = useMemo<Entry[]>(() => {
    const byKey = new Map((heat.data?.items || []).map(i => [`${i.kind}:${i.name}`, i]))
    const out: Entry[] = []
    const seen = new Set<string>()
    for (const s of skills.data?.skills || []) {
      if (seen.has(`skill:${s.name}`)) continue
      seen.add(`skill:${s.name}`)
      const h = byKey.get(`skill:${s.name}`)
      out.push({ key: `skill:${s.name}`, kind: 'skill', heatKind: 'skill', name: s.name, title: s.name, description: s.description, source: s.sourceLabel, heat: h, tier: h?.tier || 'idle' })
    }
    for (const t of tools.data?.tools || []) {
      const group: Kind = t.group === 'mcp' || t.name.startsWith('mcp_') ? 'mcp' : t.group === 'toolpack' || t.name.startsWith('tp_') ? 'toolpack' : 'builtin'
      const h = byKey.get(`tool:${t.name}`)
      const server = group === 'mcp' ? t.description.match(/^\[MCP:([^\]]+)\]/)?.[1] : undefined
      out.push({ key: `tool:${t.name}`, kind: group, heatKind: 'tool', name: t.name, title: t.name, description: t.description.replace(/^\[MCP:[^\]]+\]\s*/, ''), source: server, folded: t.folded, heat: h, tier: h?.tier || 'idle' })
    }
    return out
  }, [skills.data, tools.data, heat.data])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length }
    for (const e of entries) c[e.kind] = (c[e.kind] || 0) + 1
    return c
  }, [entries])
  const q = kw.trim().toLowerCase()
  const shown = entries.filter(e => (kind === 'all' || e.kind === kind) && (!q || `${e.name} ${e.description} ${e.source || ''}`.toLowerCase().includes(q)))
  const groups = TIERS.map(tier => ({
    tier,
    items: shown.filter(e => e.tier === tier).sort((a, b) => (Number(b.heat?.pinned) - Number(a.heat?.pinned)) || ((b.heat?.score || 0) - (a.heat?.score || 0)) || a.name.localeCompare(b.name)),
  }))
  const tierTotals = TIERS.map(t => entries.filter(e => e.tier === t).length)
  const enabled = heat.data?.enabled !== false

  const act = async (body: Parameters<typeof HeatApi.set>[0], key: string) => {
    setBusy(key); setErr('')
    try { await heat.mutate(HeatApi.set(body), { revalidate: false }) }
    catch (e: any) { setErr(`没改成：${e?.message || '未知错误'}`) }
    finally { setBusy('') }
  }
  const loading = !skills.data && !tools.data
  const failed = (skills.error || tools.error) && !entries.length

  return <section className="cap-board" data-slot="capability-board" aria-labelledby="cap-title">
    <div className="cap-hero panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="cap-title" className="text-[15px] font-semibold text-pi-text">技能与工具</h2>
          <p className="text-[12px] text-pi-dim2 mt-0.5">共 {entries.length} 项。用得越多越热：常用的工具每轮直接带上（最多额外 {heat.data?.hotToolCap ?? 8} 个），常用的技能排在前面、匹配时优先。</p>
        </div>
        <label className="cap-switch" title="关掉后回到固定名单，不按热度调整">
          <input type="checkbox" role="switch" checked={enabled} disabled={!heat.data || busy === 'enabled'} onChange={e => void act({ enabled: e.target.checked }, 'enabled')} />
          <span>热度生效</span>
        </label>
      </div>
      <div className="cap-tiers" role="list" aria-label="热度分布">
        {TIERS.map((t, i) => { const M = TIER_META[t]; return <div key={t} role="listitem" className="cap-tier-stat" style={{ ['--tier' as any]: M.color }}>
          <M.icon className="w-4 h-4" aria-hidden="true" /><b className="tabular-nums">{tierTotals[i]}</b><span>{M.label}</span>
        </div> })}
      </div>
      <div className="cap-heatbar" aria-hidden="true">
        {TIERS.map((t, i) => tierTotals[i] ? <i key={t} style={{ flexGrow: tierTotals[i], background: TIER_META[t].color }} /> : null)}
      </div>
      <div className="mt-3 flex flex-col sm:flex-row gap-2.5 sm:items-center">
        <label className="relative block sm:w-64 shrink-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-pi-dim2" aria-hidden="true" />
          <input type="search" aria-label="搜索技能与工具" className="input-pi !py-2 !pl-9 text-[13px] w-full" placeholder="搜索名字或用途" value={kw} onChange={e => setKw(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-1.5" aria-label="按类型筛选">
          {(['all', 'skill', 'builtin', 'mcp', 'toolpack'] as const).map(k => {
            const Icon = k === 'all' ? null : KIND_META[k].icon
            return <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} className={`chip-pill ${kind === k ? 'is-on' : 'is-off'} min-h-9 px-2.5 rounded-full text-[12px] border inline-flex items-center gap-1`}>
              {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}{k === 'all' ? '全部' : KIND_META[k].label}<span className="tabular-nums opacity-70">{counts[k] || 0}</span>
            </button>
          })}
        </div>
      </div>
      {heat.data && !heat.data.backfilledAt && <p className="text-[11px] text-pi-dim2 mt-2">历史用量正在回填（启动后约一分半钟），之前的使用记录稍后会计入。</p>}
      {err && <p role="alert" className="text-[12px] text-pi-danger mt-2">{err}</p>}
    </div>

    {failed ? <p role="alert" className="text-sm text-pi-danger py-4">技能与工具列表暂不可用，请刷新重试。</p>
      : loading ? <p role="status" className="text-sm text-pi-dim py-4">正在加载…</p>
      : groups.map(({ tier, items }) => {
        if (!items.length) return null
        const M = TIER_META[tier]
        return <div key={tier} className="cap-group" data-tier={tier} style={{ ['--tier' as any]: M.color }}>
          <h3 className="cap-group-title"><M.icon className="w-4 h-4" aria-hidden="true" />{M.label}<span className="tabular-nums">{items.length}</span><small>{M.hint}</small></h3>
          <div className={tier === 'idle' ? 'cap-grid cap-grid-compact' : 'cap-grid'}>
            {items.map(e => {
              const K = KIND_META[e.kind]
              const h = e.heat
              const rate = h && h.count ? Math.round((1 - h.fail / h.count) * 100) : null
              return <article key={e.key} className={`cap-card${h?.hidden ? ' is-hidden' : ''}`} title={e.description}>
                <div className="flex items-start gap-2">
                  <span className="cap-kind" aria-label={K.label}><K.icon className="w-3.5 h-3.5" aria-hidden="true" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12.5px] text-pi-text break-all leading-snug">{e.title}</div>
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <span className="cap-tag">{K.label}</span>
                      {e.source && <span className="cap-tag">{e.source}</span>}
                      {e.folded && <span className="cap-tag" title="普通聊天默认不下发；变热或钉住后直接带上，否则模型要先 request_tool 取回">默认收起</span>}
                      {h?.pinned && <span className="cap-tag is-pin">已钉住</span>}
                      {h?.hidden && <span className="cap-tag is-off">已收起</span>}
                    </div>
                  </div>
                  <div className="cap-actions">
                    <button type="button" className="cap-icon-btn" disabled={!!busy} aria-label={h?.pinned ? `取消钉住 ${e.name}` : `钉住 ${e.name}`} title={h?.pinned ? '取消钉住' : '钉住：始终算常用'} onClick={() => void act({ kind: e.heatKind, name: e.name, action: h?.pinned ? 'reset' : 'pin' }, e.key)}>{h?.pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}</button>
                    <button type="button" className="cap-icon-btn" disabled={!!busy} aria-label={h?.hidden ? `恢复 ${e.name}` : `收起 ${e.name}`} title={h?.hidden ? '恢复' : '收起：不主动给模型'} onClick={() => void act({ kind: e.heatKind, name: e.name, action: h?.hidden ? 'reset' : 'hide' }, e.key)}>{h?.hidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}</button>
                  </div>
                </div>
                {tier !== 'idle' && <p className="text-[12px] text-pi-dim mt-2 line-clamp-2 leading-relaxed">{e.description || '暂无说明'}</p>}
                {h && h.count > 0 && <div className="cap-meta">
                  <div className="cap-score" aria-label={`热度 ${Math.round(h.score * 100)}`}><i style={{ width: `${Math.round(h.score * 100)}%` }} /></div>
                  <Spark data={h.trend || []} color={M.color} />
                  <div className="cap-facts">
                    <span><b className="tabular-nums">{h.count30}</b> 次/30天</span>
                    <span>{ago(h.lastAt)}</span>
                    {rate !== null && <span className={rate < 80 ? 'text-pi-danger' : ''}>成功 {rate}%</span>}
                    {h.avgMs !== null && e.heatKind === 'tool' && <span>均 {h.avgMs < 1000 ? `${h.avgMs}ms` : `${(h.avgMs / 1000).toFixed(1)}s`}</span>}
                  </div>
                </div>}
              </article>
            })}
          </div>
        </div>
      })}
    {!loading && !failed && !shown.length && <p role="status" className="text-sm text-pi-dim py-4">没有匹配的技能或工具</p>}

    <details className="engine-detail" open={openMcp || undefined}>
      <summary><Plug2 aria-hidden="true" /><span className="engine-detail-title">管理 MCP 连接</span><span className="engine-detail-hint">添加、连接、断开外部 server</span></summary>
      <div className="engine-detail-content"><McpPanel /></div>
    </details>
  </section>
}
