import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Download, Images } from 'lucide-react'
import Downloads from './Downloads'
import PageHeader from '../components/PageHeader'
import Gallery from '../components/Gallery'
import { WsApi, withFileToken, downloadApiFile } from '../api'
import { filterAssets, mergeAssets, sortAssets } from '../lib/assets'
import type { AssetFilterQuery, AssetItem, AssetKind, AssetTimeRange } from '../types'
import AssetToolbar from '../components/assets/AssetToolbar'
import AssetCollection from '../components/assets/AssetCollection'
import AssetPreview from '../components/assets/AssetPreview'
import AssetDetails from '../components/assets/AssetDetails'

export default function Assets({ initialView = 'library' }: { initialView?: 'library' | 'downloads' } = {}) {
  const [view, setView] = useState<'library' | 'downloads'>(initialView)
  const { data: artData, error: artifactsError, isLoading: artifactsLoading, mutate: mutateArtifacts } = useSWR('artifacts', () => WsApi.artifacts(), { revalidateOnFocus: false, dedupingInterval: 10000 })
  const { data: delData, error: deliveriesError, isLoading: deliveriesLoading, mutate: mutateDeliveries } = useSWR('deliveries', () => WsApi.deliveries(), { revalidateOnFocus: false, dedupingInterval: 60000 })
  const [selectedAsset, setSelectedAsset] = useState<AssetItem | null>(null)
  const [previewAsset, setPreviewAsset] = useState<AssetItem | null>(null)
  const [kind, setKind] = useState<AssetKind | 'all'>('all')
  const [timeRange, setTimeRange] = useState<AssetTimeRange>('all')
  const [project, setProject] = useState('all')
  const [search, setSearch] = useState('')
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest')
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const allAssets = useMemo(() => mergeAssets(artData?.artifacts || [], delData?.deliveries || []), [artData, delData])
  const projects = useMemo<string[]>(() => Array.from(new Set<string>(allAssets.map(item => item.project).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [allAssets])
  const query = useMemo<AssetFilterQuery>(() => ({ kind, timeRange, project, search }), [kind, timeRange, project, search])
  const filteredAssets = useMemo(() => sortAssets(filterAssets(allAssets, query), order), [allAssets, query, order])
  const isLoading = artifactsLoading || deliveriesLoading
  const hasError = Boolean(artifactsError || deliveriesError)
  const hasFilters = kind !== 'all' || timeRange !== 'all' || project !== 'all' || Boolean(search)

  const selectAsset = (item: AssetItem) => {
    setSelectedAsset(item)
    setPreviewAsset(item.isDirectory ? null : item)
  }
  const closeDetails = () => { setSelectedAsset(null); setPreviewAsset(null) }
  const dismissMobileDetails = () => { try { if (window.matchMedia('(max-width: 800px)').matches) setSelectedAsset(null) } catch {} }
  const closePreview = () => {
    setPreviewAsset(null)
    try { if (window.matchMedia('(max-width: 800px)').matches) setSelectedAsset(null) } catch {}
  }
  const clearFilters = () => { setKind('all'); setTimeRange('all'); setProject('all'); setSearch('') }
  const showFeedback = (tone: 'ok' | 'error', text: string) => { setFeedback({ tone, text }); window.setTimeout(() => setFeedback(null), 3500) }
  const refreshAssets = async () => { await Promise.all([mutateArtifacts(), mutateDeliveries()]) }
  const openAsset = (item: AssetItem) => {
    if (item.url && (!item.isDirectory || item.openPath)) { window.open(withFileToken(item.url), '_blank', 'noopener,noreferrer'); dismissMobileDetails() }
  }
  const downloadAsset = async (item: AssetItem) => {
    if (item.isDirectory || !item.url) return
    const downloadUrl = item.url + (item.url.includes('?') ? '&' : '?') + 'download=1'
    try {
      const saved = await downloadApiFile(downloadUrl, item.name)
      showFeedback('ok', saved || '下载已开始')
      dismissMobileDetails()
    } catch (error: any) {
      showFeedback('error', '下载失败：' + (error?.message || '请稍后重试'))
    }
  }
  const renameAsset = async (item: AssetItem, newName: string) => {
    try { await WsApi.rename(item.path, newName); await refreshAssets(); setSelectedAsset(null); setPreviewAsset(null); showFeedback('ok', '资产已重命名') }
    catch (error: any) { showFeedback('error', `操作失败：${error?.message || '重命名失败'}`) }
  }
  const deleteAsset = async (item: AssetItem) => {
    if (!window.confirm(`确定删除“${item.name}”吗？`)) return
    try { await WsApi.delete(item.path); await refreshAssets(); setSelectedAsset(null); setPreviewAsset(null); showFeedback('ok', '资产已删除') }
    catch (error: any) { showFeedback('error', `操作失败：${error?.message || '删除失败'}`) }
  }

  return (
    <div className="assets-page flex-1 overflow-y-auto relative z-10">
      <div className="assets-page__inner max-w-7xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
        <PageHeader title="资产库" description="生成物与交付物集中浏览，按项目、类型和时间快速定位" meta={<span>{allAssets.length} 项资产{selectedAsset ? ` · 已选 ${selectedAsset.name}` : ''}</span>} />

        <nav aria-label="资产视图" className="flex items-center gap-1 mb-4">
          {([['library', '资产库', Images], ['downloads', '下载记录', Download]] as const).map(([key, label, Icon]) => (
            <button key={key} type="button" aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}
              className={`min-h-10 px-3 rounded-pi-md inline-flex items-center gap-2 text-[13px] transition-colors ${view === key ? 'nav-active font-medium' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg-hover'}`}>
              <Icon className="w-4 h-4" strokeWidth={1.8} aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>
        {view === 'downloads' ? <Downloads embedded /> : <>
        <Gallery />
        <AssetToolbar counts={{ total: allAssets.length, visible: filteredAssets.length, selected: selectedAsset ? 1 : 0 }} filters={{ kind, timeRange, project, search, order }} projects={projects} onKindChange={setKind} onTimeChange={setTimeRange} onProjectChange={setProject} onSearchChange={setSearch} onOrderChange={setOrder} onClear={clearFilters} />
        {feedback && <div className={`asset-feedback asset-feedback--${feedback.tone}`} role="status">{feedback.text}</div>}
        {hasError && <div className="asset-feedback asset-feedback--error" role="alert">资产服务暂时不可用，请重试。<button type="button" className="asset-retry-button" onClick={() => refreshAssets()}>重试</button></div>}
        <div className="assets-page__layout">
          <main className="assets-page__main">
            <AssetCollection items={filteredAssets} selectedId={selectedAsset?.id || null} onSelect={selectAsset} loading={isLoading} hasFilters={hasFilters} onClearFilters={clearFilters} />
          </main>
          {selectedAsset && <button type="button" className="asset-details-backdrop" aria-label="关闭资产详情" onClick={closeDetails} />}
          <AssetDetails item={selectedAsset} onRename={renameAsset} onDelete={deleteAsset} onDownload={downloadAsset} onOpen={openAsset} onPreview={setPreviewAsset} onClose={closeDetails} />
        </div>
        </>}
      </div>
      <AssetPreview item={previewAsset} onClose={closePreview} onAction={action => previewAsset && (action === 'open' ? openAsset(previewAsset) : downloadAsset(previewAsset))} />
    </div>
  )
}
