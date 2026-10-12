import ThemedSelect from '../../components/ThemedSelect'
import type { AssetFilterQuery, AssetKind, AssetTimeRange } from '../../types'

const kinds: { value: AssetKind | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'presentation', label: '演示文稿' },
  { value: 'text', label: '文本/文档' },
  { value: 'other', label: '其他' },
]
const ranges: { value: AssetTimeRange; label: string }[] = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
]

export type AssetToolbarProps = {
  counts: { total: number; visible: number; selected: number }
  filters: Required<Pick<AssetFilterQuery, 'kind' | 'timeRange' | 'project'>> & { search: string; order: 'newest' | 'oldest' }
  projects: string[]
  onKindChange: (kind: AssetKind | 'all') => void
  onTimeChange: (range: AssetTimeRange) => void
  onProjectChange: (project: string) => void
  onSearchChange: (search: string) => void
  onOrderChange: (order: 'newest' | 'oldest') => void
  onClear: () => void
}

export default function AssetToolbar({ counts, filters, projects, onKindChange, onTimeChange, onProjectChange, onSearchChange, onOrderChange, onClear }: AssetToolbarProps) {
  return (
    <section className="asset-toolbar" aria-label="资产筛选">
      <div className="asset-toolbar__top">
        <label className="asset-search">
          <span className="sr-only">搜索资产</span>
          <input className="input-pi !py-2 text-sm" value={filters.search} onChange={e => onSearchChange(e.target.value)} placeholder="搜索名称或路径" />
        </label>
        <span className="asset-count text-[12px] text-pi-dim2">{counts.visible} / {counts.total} 项</span>
      </div>
      <div className="asset-filter-row">
        <div className="asset-filter-group" aria-label="资产类型">
          {kinds.map(kind => (
            <button key={kind.value} type="button" aria-pressed={filters.kind === kind.value} onClick={() => onKindChange(kind.value)} className={`asset-filter-button ${filters.kind === kind.value ? 'is-active' : ''}`}>
              {kind.label}
            </button>
          ))}
        </div>
        <div className="asset-filter-group" aria-label="时间范围">
          {ranges.map(range => (
            <button key={range.value} type="button" aria-pressed={filters.timeRange === range.value} onClick={() => onTimeChange(range.value)} className={`asset-filter-button ${filters.timeRange === range.value ? 'is-active' : ''}`}>
              {range.label}
            </button>
          ))}
        </div>
        <label className="asset-select-label">
          <span>项目</span>
          <ThemedSelect aria-label="按项目筛选" value={filters.project} onChange={e => onProjectChange(e.target.value)}>
            <option value="all">全部项目</option>
            {projects.map(project => <option key={project} value={project}>{project}</option>)}
          </ThemedSelect>
        </label>
        <label className="asset-select-label">
          <span>排序</span>
          <ThemedSelect aria-label="资产排序" value={filters.order} onChange={e => onOrderChange(e.target.value as 'newest' | 'oldest')}>
            <option value="newest">最新优先</option>
            <option value="oldest">最早优先</option>
          </ThemedSelect>
        </label>
        {(filters.kind !== 'all' || filters.timeRange !== 'all' || filters.project !== 'all' || filters.search) && (
          <button type="button" className="asset-clear-button" onClick={onClear}>清除筛选</button>
        )}
      </div>
    </section>
  )
}
