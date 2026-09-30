import { Search } from 'lucide-react'

export type ModelTypeFilter = 'all' | 'chat' | 'image' | 'video' | 'tts' | 'asr' | 'realtime'
export type ModelFacets = { free: boolean; reasoning: boolean; vision: boolean }

export type ModelFilterBarProps = {
  type: ModelTypeFilter
  query: string
  facets: ModelFacets
  freeFirst: boolean
  switching: boolean
  onTypeChange: (type: ModelTypeFilter) => void
  onQueryChange: (query: string) => void
  onFacetChange: (facet: keyof ModelFacets) => void
  onFreeFirstChange: (enabled: boolean) => void
}

export default function ModelFilterBar({
  type,
  query,
  facets,
  freeFirst,
  switching,
  onTypeChange,
  onQueryChange,
  onFacetChange,
  onFreeFirstChange,
}: ModelFilterBarProps) {
  return (
    <section className="panel !p-3 mb-4" aria-label="筛选模型">
      <div className="flex flex-col gap-3">
        <div className="flex gap-1 flex-wrap" aria-label="模型类型">
          {([['all', '全部'], ['chat', '对话'], ['image', '绘图'], ['video', '视频'], ['tts', '朗读'], ['asr', '识别'], ['realtime', '实时通话']] as const).map(([key, label]) => (
            <button key={key} onClick={() => onTypeChange(key)} aria-pressed={type === key}
              className={`min-h-11 text-sm px-3 py-1.5 rounded-pi-md transition-colors ${type === key ? 'bg-pi-accent/15 text-pi-accent font-medium' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg3'}`}>
              {label}
            </button>
          ))}
        </div>

        <div className="relative min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-pi-dim2 pointer-events-none" />
          <input className="input-pi min-h-11 !py-1.5 !pl-9 text-base" placeholder="搜索名称、提供商或备注"
            value={query} onChange={event => onQueryChange(event.target.value)} aria-label="搜索模型" />
        </div>

        <div className="flex gap-1.5 flex-wrap items-center">
          {([['free', '免费'], ['reasoning', '推理'], ['vision', '视觉']] as const).map(([key, label]) => (
            <button key={key} onClick={() => onFacetChange(key)} aria-pressed={facets[key]}
              className={`min-h-11 text-sm px-2.5 py-1.5 rounded-pi-pill border transition-colors ${facets[key] ? 'bg-pi-accent/15 border-pi-accent/40 text-pi-accent font-medium' : 'border-pi-border text-pi-dim hover:text-pi-text hover:border-pi-border-hi'}`}>
              {label}
            </button>
          ))}
          <button onClick={() => onFreeFirstChange(!freeFirst)} aria-pressed={freeFirst} title="免费模型排前"
            className={`min-h-11 text-sm px-2.5 py-1.5 rounded-pi-pill border transition-colors ${freeFirst ? 'bg-pi-success/10 border-pi-success/30 text-pi-success font-medium' : 'border-pi-border text-pi-dim hover:text-pi-text hover:border-pi-border-hi'}`}>
            免费优先 ↓
          </button>
          {switching && <span className="text-[11px] text-pi-accent animate-pulse">切换中…</span>}
        </div>
      </div>
    </section>
  )
}
