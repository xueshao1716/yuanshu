import { useState } from 'react'
import { FlaskConical, Puzzle, StickyNote, TrendingUp, Sprout, Dna, Check, ChevronDown, ChevronRight, Loader2, HeartPulse, Archive as ArchiveIcon, Search, Laptop, Globe2, Package, SlidersHorizontal } from 'lucide-react'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import type { LucideIcon } from 'lucide-react'
import type { SkillSummary } from '../types'
import useSWR from 'swr'
import { RefineApi, SkillsApi, PromptsApi, ImprovementsApi, EvolutionApi, SkillNudgeApi, MemoryNudgeApi, MemCompressApi } from '../api'
import GardenerView from '../components/GardenerView'
import MechanismExperimentPanel from '../components/MechanismExperimentPanel'
import TaskEvidencePanel from '../components/TaskEvidencePanel'

// ── 应用中心（Phase 3）：经验沉淀台 / 技能库 / 提示词库 / 改进提案 ──

type Tab = 'refine' | 'skills' | 'prompts' | 'improve' | 'gardener' | 'evolution'
type Tool = { key: Tab; icon: LucideIcon; label: string; description: string }

const TOOL_GROUPS: { label: string; tools: Tool[] }[] = [
  {
    label: '知识资产',
    tools: [
      { key: 'refine', icon: FlaskConical, label: '经验沉淀台', description: '从近期工作中提炼、审核并应用可复用经验。' },
      { key: 'skills', icon: Puzzle, label: '技能库', description: '检索工作台已经收录的技能与能力说明。' },
      { key: 'prompts', icon: StickyNote, label: '提示词库', description: '浏览、展开并复制可复用的提示词资产。' },
    ],
  },
  {
    label: '系统改进',
    tools: [
      { key: 'improve', icon: TrendingUp, label: '改进提案', description: '分析运行数据，整理仍需处理的系统改进点。' },
      { key: 'evolution', icon: Dna, label: '进化引擎', description: '从真实执行轨迹中反思失败原因，进化提示词模板（人工审批后写回）。' },
      { key: 'gardener', icon: Sprout, label: '记忆园丁', description: '查看记忆健康状态，处理重复、冲突与待整理内容。' },
    ],
  },
]
const TOOLS = TOOL_GROUPS.flatMap(group => group.tools)

function RefineView() {
  const { data: list, mutate } = useSWR('refine-list', () => RefineApi.list(), { refreshInterval: 60000 })
  const { data: status } = useSWR('refine-status', () => RefineApi.status(), { refreshInterval: 60000 })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const pending = list?.pending || []
  const applied = list?.applied || []
  const rejected = list?.rejected || []

  const plan = async () => {
    setBusy('plan'); setMsg('')
    try {
      await RefineApi.plan()
      setMsg('已从近期工作日志生成改进提案，列表已刷新')
      await mutate()
    } catch (e: any) { setMsg('生成失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  const act = async (kind: 'approve' | 'reject', id: string) => {
    setBusy(id)
    try { await RefineApi[kind](id); await mutate() } catch {} finally { setBusy('') }
  }

  return (
    <div className="space-y-4">
      <div className="panel !p-3.5 flex items-center gap-3 flex-wrap">
        <span className="text-[12px] text-pi-dim">待审 <b className="text-pi-text">{pending.length}</b> · 已采纳 <b className="text-pi-text">{applied.length}</b> · 已拒绝 <b className="text-pi-text">{rejected.length}</b></span>
        <button className="btn-primary text-[13px] px-3 py-1.5 ml-auto disabled:opacity-60" onClick={plan} disabled={!!busy}>
          {busy === 'plan' ? '分析中…（可能要 1-2 分钟）' : '从近期工作生成提案'}
        </button>
      </div>
      {msg && <div className="text-[12px] text-pi-accent px-1">{msg}</div>}
      {[['待审提案', pending] as const, ['已采纳', applied] as const, ['已拒绝', rejected] as const].map(([label, arr]) => arr.length > 0 && (
        <div key={label}>
          <h3 className="text-[13px] font-semibold text-pi-text mb-2">{label}（{arr.length}）</h3>
          <div className="space-y-2">
            {arr.map((p: any, i: number) => (
              <div key={p.id || i} className="panel !p-3">
                <div className="text-[13px] text-pi-text font-medium">{p.title || p.name || p.id}</div>
                {p.rationale && <div className="text-[12px] text-pi-dim2 mt-1 line-clamp-3">{p.rationale}</div>}
                {(p as any).status && <div className="text-[11px] text-pi-dim2 mt-1">状态：{(p as any).status}</div>}
                {label === '待审提案' && p.id && (
                  <div className="flex gap-2 mt-2">
                    <button className="btn-primary text-[13px] px-3 py-1 disabled:opacity-60" disabled={busy === p.id} onClick={() => act('approve', p.id)}>{busy === p.id ? '处理中…' : '采纳执行'}</button>
                    <button className="btn-tool text-[13px]" onClick={() => act('reject', p.id)}>拒绝</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {!pending.length && !applied.length && !rejected.length && (
        <EmptyState icon={FlaskConical} title="暂无提案" hint="点上方按钮，让小语分析近期工作日志、主动提出改进建议" />
      )}
    </div>
  )
}

function SkillsView() {
  const [kw, setKw] = useState('')
  const [sourceFilter, setSourceFilter] = useState<'all' | 'local' | 'online' | 'builtin'>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const { data } = useSWR('skills', () => SkillsApi.list())
  const allSkills = data?.skills || []
  const fallbackCategory = (skill: SkillSummary) => {
    if (skill.category) return skill.category
    const text = `${skill.name} ${skill.description}`.toLowerCase()
    const rules: Array<[string, string[]]> = [
      ['presentation', ['ppt', 'powerpoint', 'slide', 'presentation', '幻灯', '演示文稿']],
      ['video', ['video', 'animation', 'motion', '视频', '动效', '动画']],
      ['image', ['image', 'photo', 'portrait', '图片', '图像', '摄影', '人像', '出图']],
      ['document', ['document', 'word', 'pdf', 'markdown', '文档', '法条', '办公']],
      ['research', ['research', 'search', 'browser', 'paper', '分析', '检索', '搜索', '论文']],
      ['engineering', ['code', 'debug', 'test', 'frontend', 'backend', 'sdk', 'api', '开发', '调试', '测试']],
      ['commerce', ['commerce', 'ecommerce', 'marketing', 'wechat', 'shopping', '电商', '营销', '公众号', '小红书', '带货']],
      ['data', ['spreadsheet', 'excel', 'stock', 'chart', 'data', '股票', '数据', '图表', '表格']],
      ['creative', ['design', 'creative', 'illustrat', 'poster', 'zine', 'scene', '设计', '插画', '海报', '场景', '视觉']],
      ['automation', ['automat', 'agent', 'workflow', 'plugin', 'skill', 'system', '自动', '工作流', '智能体', '系统']],
    ]
    return rules.find(([, keywords]) => keywords.some(keyword => text.includes(keyword)))?.[0] || 'general'
  }
  const categoryLabelFor = (skill: SkillSummary) => skill.categoryLabel || ({
    creative: '创作设计', image: '图像视觉', video: '视频与动效', presentation: '演示文稿', document: '文档与办公',
    research: '研究与搜索', engineering: '开发与工程', automation: '自动化与系统', commerce: '内容营销', data: '数据分析', general: '通用助手',
  } as Record<string, string>)[fallbackCategory(skill)] || '通用助手'
  const sourceMeta = {
    local: { label: '自建 · 本地', icon: Laptop, tone: 'text-pi-accent bg-pi-accent-soft border-pi-accent/25' },
    online: { label: '线上 · 已安装', icon: Globe2, tone: 'text-pi-info bg-pi-info/10 border-pi-info/25' },
    builtin: { label: '内置 · 只读', icon: Package, tone: 'text-pi-dim bg-pi-bg3 border-pi-border-soft' },
  } as const
  const sourceCounts = data?.sources || allSkills.reduce<Record<string, number>>((result, skill) => {
    const source = skill.source || (skill.location === 'user' ? 'online' : skill.location === 'project' ? 'local' : 'builtin')
    result[source] = (result[source] || 0) + 1
    return result
  }, {})
  const categoryCounts = data?.categories || allSkills.reduce<Record<string, number>>((result, skill) => {
    const category = fallbackCategory(skill)
    result[category] = (result[category] || 0) + 1
    return result
  }, {})
  const categoryLabels = allSkills.reduce<Record<string, string>>((result, skill) => {
    const category = fallbackCategory(skill)
    result[category] = categoryLabelFor(skill)
    return result
  }, {})
  const categories = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])
  const query = kw.trim().toLowerCase()
  const skills = allSkills.filter(skill => {
    const source = skill.source || (skill.location === 'user' ? 'online' : skill.location === 'project' ? 'local' : 'builtin')
    const category = fallbackCategory(skill)
    const searchable = [skill.name, skill.description, ...(skill.tags || []), skill.sourceLabel, skill.categoryLabel].filter(Boolean).join(' ').toLowerCase()
    return (!query || searchable.includes(query)) && (sourceFilter === 'all' || source === sourceFilter) && (categoryFilter === 'all' || category === categoryFilter)
  })
  return (
    <div className="space-y-3.5">
      <div className="panel !p-3.5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-pi-md bg-pi-accent-soft text-pi-accent flex items-center justify-center flex-shrink-0"><Puzzle className="w-4 h-4" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap"><span className="text-[15px] font-semibold text-pi-text">技能目录</span><span className="text-[11px] text-pi-dim2">{allSkills.length} 项能力，按来源和用途整理</span></div>
            <div className="text-[12px] text-pi-dim2 mt-0.5">自建技能用于沉淀你的方法，线上技能来自已安装的能力包，内置技能保持开箱即用。</div>
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2.5">
          <label className="relative block w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-pi-dim2" aria-hidden="true" />
            <input className="input-pi !py-2 !pl-9 text-[13px] w-full" placeholder={`搜索技能名称、用途或标签（${allSkills.length}）`} value={kw} onChange={e => setKw(e.target.value)} />
          </label>
          <div className="flex items-center gap-2 flex-wrap" aria-label="按来源筛选">
            <span className="inline-flex items-center gap-1 text-[11px] text-pi-dim2 mr-0.5"><SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" />来源</span>
            <button type="button" aria-pressed={sourceFilter === 'all'} onClick={() => setSourceFilter('all')} className={`min-h-9 px-2.5 rounded-pi-pill border text-[12px] transition-colors ${sourceFilter === 'all' ? 'bg-pi-text text-pi-bg border-pi-text' : 'text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-border'}`}>全部 <span className="tabular-nums opacity-70">{allSkills.length}</span></button>
            {(Object.keys(sourceMeta) as Array<keyof typeof sourceMeta>).map(source => {
              const meta = sourceMeta[source]; const Icon = meta.icon
              return <button key={source} type="button" aria-pressed={sourceFilter === source} onClick={() => setSourceFilter(source)} className={`min-h-9 px-2.5 rounded-pi-pill border inline-flex items-center gap-1.5 text-[12px] transition-colors ${sourceFilter === source ? meta.tone : 'text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-border'}`}><Icon className="w-3.5 h-3.5" aria-hidden="true" />{meta.label} <span className="tabular-nums opacity-70">{sourceCounts[source] || 0}</span></button>
            })}
          </div>
          {categories.length > 0 && <div className="flex items-center gap-2 flex-wrap" aria-label="按用途筛选">
            <span className="text-[11px] text-pi-dim2 mr-0.5">用途</span>
            <button type="button" aria-pressed={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')} className={`min-h-9 px-2.5 rounded-pi-pill border text-[12px] transition-colors ${categoryFilter === 'all' ? 'bg-pi-accent text-pi-on-accent border-pi-accent' : 'text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-border'}`}>全部</button>
            {categories.map(([category, count]) => <button key={category} type="button" aria-pressed={categoryFilter === category} onClick={() => setCategoryFilter(category)} className={`min-h-9 px-2.5 rounded-pi-pill border text-[12px] transition-colors ${categoryFilter === category ? 'bg-pi-accent-soft text-pi-accent border-pi-accent/30' : 'text-pi-dim border-pi-border-soft hover:text-pi-text hover:border-pi-border'}`}>{categoryLabels[category]} <span className="tabular-nums opacity-70">{count}</span></button>)}
          </div>}
        </div>
      </div>
      <div className="flex items-center gap-2 px-0.5 text-[12px] text-pi-dim2"><span>显示 <b className="text-pi-text tabular-nums">{skills.length}</b> 项</span>{(sourceFilter !== 'all' || categoryFilter !== 'all' || query) && <button type="button" className="text-pi-accent hover:underline" onClick={() => { setKw(''); setSourceFilter('all'); setCategoryFilter('all') }}>清除筛选</button>}</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2.5">
        {skills.map((s: SkillSummary) => {
          const source = s.source || (s.location === 'user' ? 'online' : s.location === 'project' ? 'local' : 'builtin')
          const meta = sourceMeta[source]
          const categoryLabel = categoryLabelFor(s) || categoryLabels[fallbackCategory(s)] || '通用助手'
          return <div key={`${s.name}:${s.path || s.location || source}`} className="panel !p-3.5 flex flex-col min-h-[142px]" title={s.path || s.location}>
            <div className="flex items-start gap-2"><div className="font-mono text-[13px] text-pi-accent break-all flex-1">{s.name}</div><span className={`inline-flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded-pi-pill border ${meta.tone}`}><meta.icon className="w-3 h-3" aria-hidden="true" />{s.sourceLabel || meta.label}</span></div>
            <div className="flex items-center gap-1.5 mt-2"><span className="text-[11px] px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim border border-pi-border-soft">{categoryLabel}</span>{(s.tags || []).filter(tag => tag !== categoryLabel).slice(0, 2).map(tag => <span key={tag} className="text-[11px] text-pi-dim2 truncate">#{tag}</span>)}</div>
            <div className="text-[12px] text-pi-dim mt-2 line-clamp-3 leading-relaxed">{s.description || '暂无用途说明'}</div>
          </div>
        })}
      </div>
      {!skills.length && (
        <EmptyState icon={Puzzle} title="没有匹配的技能" />
      )}
    </div>
  )
}

function PromptsView() {
  const { data } = useSWR('prompts', () => PromptsApi.list())
  const [open, setOpen] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const prompts = data?.prompts || []
  const copy = async (p: any) => {
    try { await navigator.clipboard.writeText(p.content); setCopied(p.name); setTimeout(() => setCopied(''), 1500) } catch {}
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1 text-[12px] text-pi-dim2">
        <span>提示词资产</span>
        <span className="tabular-nums">当前 {prompts.length} 个 · 来自本机提示词目录</span>
      </div>
      {prompts.map(p => (
        <div key={p.name} className="panel !p-3">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setOpen(open === p.name ? null : p.name)}>
            <span className="text-[13px] text-pi-text font-medium flex-1">{p.name}<span className="text-pi-dim2 font-normal ml-2 text-[12px]">{p.description}</span></span>
            <button className="btn-tool text-[13px] !px-2 inline-flex items-center gap-1" title="复制内容" onClick={e => { e.stopPropagation(); copy(p) }}>{copied === p.name && <Check className="w-3.5 h-3.5" aria-hidden="true" />}{copied === p.name ? '已复制' : '复制'}</button>
            {open === p.name ? <ChevronDown className="w-3.5 h-3.5 text-pi-dim2" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-pi-dim2" aria-hidden="true" />}
          </div>
          {open === p.name && <pre className="mt-2 pt-2 border-t border-pi-border-soft text-[12px] text-pi-dim whitespace-pre-wrap max-h-64 overflow-auto font-mono">{p.content}</pre>}
        </div>
      ))}
      {!prompts.length && (
        <EmptyState icon={StickyNote} title="提示词库为空" hint="在本机提示词目录放入 .md 文件即可" />
      )}
    </div>
  )
}

function ImproveView() {
  const { data, mutate } = useSWR('improvements', () => ImprovementsApi.list())
  const [busy, setBusy] = useState(false)
  const items = data?.improvements || []
  const diagnostics = data?.diagnostics
  const analyze = async () => {
    setBusy(true)
    try { await ImprovementsApi.analyze(); await mutate() } catch {} finally { setBusy(false) }
  }
  const dismiss = async (id: string) => { try { await ImprovementsApi.setStatus(id, 'dismissed'); await mutate() } catch {} }
  return (
    <div className="space-y-3">
      <button className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-60" onClick={analyze} disabled={busy}>
        {busy ? '分析中…' : '分析运行数据找改进点'}
      </button>
      {diagnostics && (
        <div className="panel !p-3 text-[12px] text-pi-dim2">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <span>普通改进 <b className="text-pi-text">{diagnostics.openImprovements}</b></span>
            <span>进化提案 <b className="text-pi-text">{diagnostics.openEvolution}</b></span>
            <span>技能沉淀 <b className="text-pi-text">{diagnostics.openSkillNudge}</b></span>
            <span>记忆提案 <b className="text-pi-text">{diagnostics.openMemoryNudge}</b></span>
          </div>
          {!diagnostics.openImprovements && (diagnostics.openEvolution + diagnostics.openSkillNudge + diagnostics.openMemoryNudge > 0) && (
            <div className="mt-1.5">其他提案已分别放在「进化引擎」「技能库」和「记忆园丁」，不会混进普通改进提案。</div>
          )}
        </div>
      )}
      {items.map((it: any, i: number) => (
        <div key={it.id || i} className="panel !p-3">
          <div className="text-[13px] text-pi-text font-medium">{it.title || it.summary || it.id}</div>
          {it.detail && <div className="text-[12px] text-pi-dim2 mt-1 line-clamp-4">{it.detail}</div>}
          <button className="btn-tool text-[13px] mt-2" onClick={() => it.id && dismiss(it.id)}>忽略</button>
        </div>
      ))}
      {!items.length && (
        <EmptyState icon={TrendingUp} title="当前没有待处理的普通改进提案" hint="分析只会在冷却、用量或自愈次数达到阈值时生成；进化类提案请到对应模块查看" />
      )}
    </div>
  )
}

export default function Apps() {
  const [tab, setTab] = useState<Tab>('refine')
  const currentTool = TOOLS.find(tool => tool.key === tab) || TOOLS[0]

  return (
    <div className="flex-1 overflow-y-auto relative z-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
        <PageHeader
          title="知识"
          description="在知识资产与系统改进工具之间切换，让每类工作保留自己的操作语境。"
        />

        <select
          aria-label="选择应用工具"
          className="input-pi min-h-11 !py-2 text-[13px] w-full md:hidden mb-5"
          value={tab}
          onChange={event => setTab(event.target.value as Tab)}
        >
          {TOOL_GROUPS.map(group => (
            <optgroup key={group.label} label={group.label}>
              {group.tools.map(tool => <option key={tool.key} value={tool.key}>{tool.label}</option>)}
            </optgroup>
          ))}
        </select>

        <div className="md:grid md:grid-cols-[190px_minmax(0,1fr)] md:gap-6 items-start">
          <aside className="hidden md:block sticky top-6">
            <nav aria-label="应用工具导航" className="space-y-5">
              {TOOL_GROUPS.map(group => (
                <div key={group.label}>
                  <div className="px-2 mb-1.5 text-[11px] font-medium text-pi-dim2">{group.label}</div>
                  <div className="space-y-1">
                    {group.tools.map(tool => {
                      const Icon = tool.icon
                      return (
                        <button
                          key={tool.key}
                          type="button"
                          aria-current={tab === tool.key ? 'page' : undefined}
                          onClick={() => setTab(tool.key)}
                          className={`w-full min-h-10 px-2.5 py-2 rounded-pi-md inline-flex items-center gap-2 text-left text-[13px] transition-colors ${tab === tool.key ? 'nav-active font-medium' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg-hover'}`}
                        >
                          <Icon className="w-4 h-4 flex-shrink-0" strokeWidth={1.8} aria-hidden="true" />
                          <span>{tool.label}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </aside>

          <main className="min-w-0">
            <SectionHeader title={currentTool.label} description={currentTool.description} icon={currentTool.icon} />
            <div key={tab} className="page-enter">
              {tab === 'refine' && <RefineView />}
              {tab === 'skills' && <SkillsView />}
              {tab === 'prompts' && <PromptsView />}
              {tab === 'improve' && <ImproveView />}
              {tab === 'evolution' && <EvolutionView />}
              {tab === 'gardener' && <GardenerView />}
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}

// ── 进化引擎视图（09-03）：反思式提示词进化，人工审批红线 ──
function EvolutionView() {
  const { data: plist } = useSWR('prompts', () => PromptsApi.list())
  const { data: propsals, mutate } = useSWR('evolution', () => EvolutionApi.list())
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [openVar, setOpenVar] = useState('')
  const templates = plist?.prompts || []
  const items = propsals?.proposals || []

  const propose = async () => {
    if (!target) { setMsg('先选一个要进化的模板'); return }
    setBusy(target); setMsg('反思中：抽轨迹 → 分析失败原因 → 生成候选（约 30-90 秒）…')
    try {
      const r = await EvolutionApi.propose(target)
      setMsg(r.ok ? `已生成 ${r.variants} 个候选（基于 ${r.traces} 条纠正轨迹）：${r.analysis || ''}` : `进化失败：${r.error || '未知'}`)
      await mutate()
    } catch (e: any) { setMsg('进化失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  const act = async (kind: 'apply' | 'dismiss', id: string, vi = 0) => {
    setBusy(id + vi)
    try {
      if (kind === 'apply') {
        const r = await EvolutionApi.apply(id, vi)
        setMsg(r.ok ? `已写回（原版备份：${r.backup}）` : `应用失败：${r.error}`)
      } else { await EvolutionApi.dismiss(id); setMsg('已驳回') }
      await mutate()
    } catch (e: any) { setMsg('操作失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  const evaluate = async (id: string) => {
    setBusy('eval-' + id)
    try {
      const r = await EvolutionApi.evaluate(id)
      if (r.ok) {
        setMsg('评测已在后台开始（出题 → 各变体作答 → 评分，约 5-10 分钟）。完成后提案卡会自动显示分数，页面会轮询刷新。')
        // 轮询：评测写回提案池后自动刷出分数
        const timer = setInterval(async () => {
          const d = await EvolutionApi.list()
          const p = (d.proposals || []).find((x: any) => x.id === id)
          if (p?.evaluation) { clearInterval(timer); await mutate(); setMsg(`评测完成，最优：${p.evaluation.best}`); setBusy('') }
        }, 20000)
        setTimeout(() => clearInterval(timer), 15 * 60_000) // 15 分钟兜底
      } else setMsg(`评测启动失败：${r.error || '未知'}`)
    } catch (e: any) { setMsg('评测失败：' + (e?.message || e)); setBusy('') }
  }
  const scoreBadge = (label: string, avg?: number, best?: string) => (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-pi-pill border ${best === label ? 'bg-pi-success/15 text-pi-success border-pi-success/30' : 'bg-pi-bg3 text-pi-dim2 border-pi-border-soft'}`}>{label}: <b className="tabular-nums">{avg ?? '-'}</b></span>
  )

  return (
    <div className="space-y-3">
      <div className="panel !p-3.5">
        <div className="flex items-center gap-2 flex-wrap">
          <Dna className="w-4 h-4 text-pi-accent" />
          <span className="text-[13px] font-semibold text-pi-text">反思式进化</span>
          <span className="text-[11px] text-pi-dim2">从会话轨迹里的纠正样本学习为什么失败，人工审批后才写回</span>
        </div>
        <div className="flex items-center gap-2 mt-2.5">
          <select value={target} onChange={e => setTarget(e.target.value)} className="text-[13px] px-2 py-1.5 rounded-pi-md border border-pi-border bg-pi-bg1 text-pi-text min-w-[180px]">
            <option value="">选择提示词模板…</option>
            {templates.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button className="btn-primary text-[13px] px-3 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5" onClick={propose} disabled={!!busy || !target}>
            {busy === target ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />进化中…</> : <><Dna className="w-3.5 h-3.5" />开始进化</>}
          </button>
        </div>
        {msg && <div className="text-[11px] text-pi-dim mt-2 leading-relaxed">{msg}</div>}
      </div>

      {items.map((it: any) => (
        <div key={it.id} className="panel !p-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-pi-text">{it.target?.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-pi-pill border ${it.state === 'open' ? 'bg-pi-accent-soft text-pi-accent border-pi-accent/30' : it.state === 'applied' ? 'bg-pi-success/15 text-pi-success border-pi-success/30' : 'bg-pi-bg3 text-pi-dim2 border-pi-border-soft'}`}>{it.state === 'open' ? '待审' : it.state === 'applied' ? '已应用' : '已驳回'}</span>
            <span className="ml-auto text-[10px] text-pi-dim2">{String(it.created).slice(5, 16).replace('T', ' ')} · {it.traces} 条轨迹</span>
          </div>
          {it.analysis && <div className="text-[12px] text-pi-dim mt-1.5 leading-relaxed">失败分析：{it.analysis}</div>}
          {it.evaluation ? (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="text-[10px] text-pi-dim2">评测:</span>
              {scoreBadge('原版', it.evaluation.original?.avg, it.evaluation.best)}
              {(it.evaluation.variants || []).map((v: any) => scoreBadge(v.label, v.avg, it.evaluation.best))}
              {it.evaluation.best && <span className="text-[10px] text-pi-success">★ 最优: {it.evaluation.best}</span>}
            </div>
          ) : null}
          {it.state === 'open' && (
            <button className="btn-tool text-[12px] mt-2 inline-flex items-center gap-1" onClick={() => evaluate(it.id)} disabled={busy === 'eval-' + it.id}>
              {busy === 'eval-' + it.id ? <><Loader2 className="w-3 h-3 animate-spin" />评测中…</> : '跑评测（出题对比各变体）'}
            </button>
          )}
          <div className="mt-2 space-y-2">
            {(it.variants || []).map((v: any, vi: number) => (
              <div key={vi} className="rounded-pi-md border border-pi-border-soft p-2.5">
                <div className="flex items-center gap-2 cursor-pointer" onClick={() => setOpenVar(openVar === it.id + vi ? '' : it.id + vi)}>
                  <Dna className="w-3.5 h-3.5 text-pi-dim" />
                  <span className="text-[12px] font-medium text-pi-text">{v.label}</span>
                  <span className="text-[11px] text-pi-dim2 truncate">{v.rationale}</span>
                  <ChevronRight className={`w-3.5 h-3.5 ml-auto text-pi-dim2 transition-transform ${openVar === it.id + vi ? 'rotate-90' : ''}`} />
                </div>
                {openVar === it.id + vi && (
                  <pre className="mt-2 pt-2 border-t border-pi-border-soft text-[11px] text-pi-dim whitespace-pre-wrap max-h-56 overflow-auto font-mono">{v.content}</pre>
                )}
                {it.state === 'open' && (
                  <div className="flex gap-2 mt-2">
                    <button className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-60" onClick={() => act('apply', it.id, vi)} disabled={busy === it.id + vi}>{busy === it.id + vi ? '写回中…' : '应用此变体'}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {it.state === 'open' && <button className="btn-tool text-[12px] mt-2" onClick={() => act('dismiss', it.id)}>整单驳回</button>}
          {it.backup && <div className="text-[10px] text-pi-dim2 mt-1.5">原版备份：{it.backup}</div>}
        </div>
      ))}
      {!items.length && <EmptyState icon={Dna} title="还没有进化提案" hint="选择模板点「开始进化」，小语会从近期会话里的纠正样本中学习" />}

      <TaskEvidencePanel />
      <MechanismExperimentPanel />

      {/* 技能自主沉淀（Hermes 闭环）：定时任务完成后自动评估 */}
      <SkillNudgeSection />

      {/* 记忆 nudge（情绪→记忆联动）：residue 跨阈值自动提案 */}
      <MemoryNudgeSection />

      {/* 记忆进化压缩（EvoX MemoryOptimizer）*/}
      <MemCompressSection />
    </div>
  )
}

function MemCompressSection() {
  const { data: ana, mutate: mutAna } = useSWR('memcompress-analyze', () => MemCompressApi.analyze())
  const { data: lst, mutate: mutLst } = useSWR('memcompress-list', () => MemCompressApi.list())
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [openItem, setOpenItem] = useState('')
  const proposals = (lst?.proposals || []).filter((p: any) => p.state === 'open')
  const propose = async () => {
    setBusy('propose'); setMsg('正在生成压缩提案：LLM 把早期条目压成要点摘要…')
    try {
      const r = await MemCompressApi.propose()
      setMsg(r.ok ? `提案已生成：${r.archiveCount} 条早期条目 → 要点摘要` : `未能生成：${r.error}`)
      await mutLst()
    } catch (e: any) { setMsg('失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  const act = async (kind: 'apply' | 'dismiss', id: string) => {
    setBusy(id)
    try {
      if (kind === 'apply') {
        const r = await MemCompressApi.apply(id)
        setMsg(r.ok ? `已压缩：日志备份 ${r.backup}，原文归档 ${r.archiveFile}` : `失败：${r.error}`)
        await mutAna()
      } else { await MemCompressApi.dismiss(id); setMsg('已驳回') }
      await mutLst()
    } catch (e: any) { setMsg('操作失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  return (
    <div className="panel !p-3.5">
      <div className="flex items-center gap-2">
        <ArchiveIcon className="w-4 h-4 text-pi-accent" />
        <span className="text-[13px] font-semibold text-pi-text">记忆进化压缩</span>
        <span className="text-[11px] text-pi-dim2">14 天前的条目摘要化，原文归档，永不触碰近期记忆</span>
      </div>
      {msg && <div className="text-[11px] text-pi-dim mt-1.5">{msg}</div>}
      {ana && !ana.error && (
        <div className="flex items-center gap-3 mt-2 text-[11px] text-pi-dim2">
          <span>共 <b className="text-pi-text">{ana.total}</b> 条</span>
          <span>近期 {ana.fresh} 条（不动）</span>
          <span>早期 {ana.old} 条{ana.worthIt ? '（可压缩）' : `（不足 20 条，暂不压缩）`}</span>
          {ana.worthIt && <button className="btn-tool text-[11px]" onClick={propose} disabled={busy === 'propose'}>{busy === 'propose' ? '生成中…' : '生成压缩提案'}</button>}
        </div>
      )}
      <div className="mt-2 space-y-2">
        {proposals.map((p: any) => (
          <div key={p.id} className="rounded-pi-md border border-pi-border-soft p-2.5">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setOpenItem(openItem === p.id ? '' : p.id)}>
              <span className="text-[12px] font-medium text-pi-text">{p.beforeCount} → {p.keptCount} 条</span>
              <span className="text-[11px] text-pi-dim2">{p.archiveCount} 条早期条目压缩为要点（{String(p.created).slice(5, 16).replace('T', ' ')}）</span>
              <ChevronRight className={`w-3.5 h-3.5 ml-auto text-pi-dim2 transition-transform ${openItem === p.id ? 'rotate-90' : ''}`} />
            </div>
            {openItem === p.id && <pre className="mt-2 pt-2 border-t border-pi-border-soft text-[11px] text-pi-dim whitespace-pre-wrap max-h-56 overflow-auto">{p.summaryText}</pre>}
            <div className="flex gap-2 mt-2">
              <button className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-60" onClick={() => act('apply', p.id)} disabled={busy === p.id}>{busy === p.id ? '压缩中…' : '确认压缩（自动备份+归档）'}</button>
              <button className="btn-tool text-[12px]" onClick={() => act('dismiss', p.id)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const MEM_LABELS: Record<string, string> = { correction: '纠正记忆', warmth: '温暖瞬间', curiosity: '探索方向' }
function MemoryNudgeSection() {
  const { data, mutate } = useSWR('memorynudge', () => MemoryNudgeApi.list())
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const nudges = (data?.nudges || []).filter((n: any) => n.state === 'open')
  const act = async (kind: 'apply' | 'dismiss', id: string) => {
    setBusy(id)
    try {
      if (kind === 'apply') {
        const r = await MemoryNudgeApi.apply(id)
        setMsg(r.ok ? `已写入：${r.file}` : `写入失败：${r.error}`)
      } else { await MemoryNudgeApi.dismiss(id); setMsg('已驳回') }
      await mutate()
    } catch (e: any) { setMsg('操作失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  if (!nudges.length && !msg) return null
  return (
    <div className="panel !p-3.5">
      <div className="flex items-center gap-2">
        <HeartPulse className="w-4 h-4 text-pi-accent" />
        <span className="text-[13px] font-semibold text-pi-text">情绪记忆提案</span>
        <span className="text-[11px] text-pi-dim2">情绪残留跨过阈值时自动生成，人工确认写入记忆文件</span>
        {nudges.length > 0 && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-pi-pill bg-pi-accent-soft text-pi-accent">{nudges.length} 条待审</span>}
      </div>
      {msg && <div className="text-[11px] text-pi-dim mt-1.5">{msg}</div>}
      <div className="mt-2 space-y-2">
        {nudges.map((n: any) => (
          <div key={n.id} className="rounded-pi-md border border-pi-border-soft p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim border border-pi-border-soft">{MEM_LABELS[n.subtype] || n.subtype}</span>
              <span className="text-[11px] text-pi-dim2">残留 {n.residue}</span>
              <span className="ml-auto text-[10px] text-pi-dim2">{String(n.created).slice(5, 16).replace('T', ' ')}</span>
            </div>
            <div className="text-[12px] text-pi-dim mt-1.5 leading-relaxed">{n.draft}</div>
            <div className="flex gap-2 mt-2">
              <button className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-60" onClick={() => act('apply', n.id)} disabled={busy === n.id}>{busy === n.id ? '写入中…' : '写入记忆'}</button>
              <button className="btn-tool text-[12px]" onClick={() => act('dismiss', n.id)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkillNudgeSection() {
  const { data, mutate } = useSWR('skillnudge', () => SkillNudgeApi.list())
  const [busy, setBusy] = useState('')
  const [openItem, setOpenItem] = useState('')
  const [msg, setMsg] = useState('')
  const nudges = (data?.nudges || []).filter((n: any) => n.state === 'open')
  const act = async (kind: 'apply' | 'dismiss', id: string) => {
    setBusy(id)
    try {
      if (kind === 'apply') {
        const r = await SkillNudgeApi.apply(id)
        setMsg(r.ok ? `技能已入库：${r.path}` : `入库失败：${r.error}`)
      } else { await SkillNudgeApi.dismiss(id); setMsg('已驳回') }
      await mutate()
    } catch (e: any) { setMsg('操作失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  if (!nudges.length && !msg) return null
  return (
    <div className="panel !p-3.5">
      <div className="flex items-center gap-2">
        <Sprout className="w-4 h-4 text-pi-accent" />
        <span className="text-[13px] font-semibold text-pi-text">技能自主沉淀</span>
        <span className="text-[11px] text-pi-dim2">定时任务完成后自动评估，人工确认入库</span>
        {nudges.length > 0 && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-pi-pill bg-pi-accent-soft text-pi-accent">{nudges.length} 条待审</span>}
      </div>
      {msg && <div className="text-[11px] text-pi-dim mt-1.5">{msg}</div>}
      <div className="mt-2 space-y-2">
        {nudges.map((n: any) => (
          <div key={n.id} className="rounded-pi-md border border-pi-border-soft p-2.5">
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => setOpenItem(openItem === n.id ? '' : n.id)}>
              <span className="text-[12px] font-medium text-pi-text">{n.name}</span>
              <span className="text-[11px] text-pi-dim2 truncate">{n.description || n.label}</span>
              <ChevronRight className={`w-3.5 h-3.5 ml-auto text-pi-dim2 transition-transform ${openItem === n.id ? 'rotate-90' : ''}`} />
            </div>
            {openItem === n.id && <pre className="mt-2 pt-2 border-t border-pi-border-soft text-[11px] text-pi-dim whitespace-pre-wrap max-h-56 overflow-auto font-mono">{n.skill}</pre>}
            <div className="flex gap-2 mt-2">
              <button className="btn-primary text-[12px] px-2.5 py-1 disabled:opacity-60" onClick={() => act('apply', n.id)} disabled={busy === n.id}>{busy === n.id ? '入库中…' : '确认入库'}</button>
              <button className="btn-tool text-[12px]" onClick={() => act('dismiss', n.id)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
