import { Search as EmptySearchIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { StatsApi, KeysApi } from '../api'
import type { ProviderStat } from '../api'
import EmptyState from '../components/EmptyState'
import ModelChannels from '../components/ModelChannels'
import PageHeader from '../components/PageHeader'
import ActiveModelHero from '../components/models/ActiveModelHero'
import ModelCard from '../components/models/ModelCard'
import ModelFilterBar from '../components/models/ModelFilterBar'
import type { ModelFacets, ModelTypeFilter } from '../components/models/ModelFilterBar'
import { useApp } from '../store'
import type { Model } from '../types'

const fmtTokens = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : String(value || 0)
const fmtCost = (value: number) => `$${(value || 0).toFixed(2)}`

function capabilityKeys(model: Model): string[] {
  const capabilities = model.capabilities as unknown
  return Array.isArray(capabilities)
    ? capabilities
    : Object.entries(capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => key)
}

function isFree(model: Model) {
  return Boolean(model.free || (model.note || '').includes('免费'))
}

function ProviderUsageTable({ providers }: { providers: ProviderStat[] }) {
  return (
    <div className="overflow-x-auto border-t border-pi-border-soft">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-pi-dim2 border-b border-pi-border-soft">
            <th className="px-4 py-2 font-medium">Provider</th>
            <th className="px-4 py-2 font-medium">输入</th>
            <th className="px-4 py-2 font-medium">输出</th>
            <th className="px-4 py-2 font-medium">缓存命中</th>
            <th className="px-4 py-2 font-medium">消息</th>
            <th className="px-4 py-2 font-medium">成本</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(provider => (
            <tr key={provider.provider} className="border-b border-pi-border-soft/50 hover:bg-pi-bg3/40 transition-colors">
              <td className="px-4 py-2 font-medium text-pi-text">{provider.provider}</td>
              <td className="px-4 py-2 text-pi-dim">{fmtTokens(provider.input)}</td>
              <td className="px-4 py-2 text-pi-dim">{fmtTokens(provider.output)}</td>
              <td className="px-4 py-2 text-pi-dim">{fmtTokens(provider.cacheRead || 0)}</td>
              <td className="px-4 py-2 text-pi-dim">{provider.messages}</td>
              <td className="px-4 py-2 text-pi-dim">{fmtCost(provider.cost)}</td>
            </tr>
          ))}
          {!providers.length && <tr><td colSpan={6} className="px-4 py-6 text-center text-pi-dim2">暂无用量数据</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

export default function ModelHub() {
  const { models, currentModel, setCurrentModel, cwd, refreshModels } = useApp()
  const [filter, setFilter] = useState<ModelTypeFilter>('all')
  const [query, setQuery] = useState('')
  const [facets, setFacets] = useState<ModelFacets>({ free: false, reasoning: false, vision: false })
  const [freeFirst, setFreeFirst] = useState(true)
  const [switching, setSwitching] = useState('')
  const [verifying, setVerifying] = useState('')
  const [error, setError] = useState('')
  const operationLock = useRef(false)
  const { data: stats } = useSWR('provider-stats', () => StatsApi.providers(), { refreshInterval: 60000 })

  const keyword = query.trim().toLowerCase()
  const filteredModels = models.filter(model => {
    if (filter !== 'all') {
      const keys = capabilityKeys(model)
      const media = keys.some(key => ['image', 'video', 'tts', 'asr'].includes(key))
      const chat = keys.includes('chat') || (!media && model.capabilities?.chat !== false)
      if (filter === 'chat' ? !chat : !media) return false
    }
    if (keyword && !(`${model.name} ${model.provider} ${model.id} ${model.note || ''}`.toLowerCase().includes(keyword))) return false
    if (facets.free && !isFree(model)) return false
    if (facets.reasoning && !model.reasoning) return false
    if (facets.vision && !model.vision && model.capabilities?.vision !== true) return false
    return true
  })
  const visibleModels = freeFirst
    ? [...filteredModels].sort((a, b) => Number(isFree(b)) - Number(isFree(a)))
    : [...filteredModels]

  const activeModel = currentModel === 'auto/auto'
    ? undefined
    : models.find(model => `${model.provider}/${model.id}` === currentModel)
  const freeCount = models.filter(isFree).length
  const providers = stats?.providers || []
  const totalCost = providers.reduce((sum, provider) => sum + (provider.cost || 0), 0)
  const totalMessages = providers.reduce((sum, provider) => sum + (provider.messages || 0), 0)
  const filtering = Boolean(keyword || facets.free || facets.reasoning || facets.vision || filter !== 'all')

  const useModel = async (model: Model) => {
    if (operationLock.current) return
    operationLock.current = true; setError('')
    const modelKey = `${model.provider}/${model.id}`
    setSwitching(modelKey)
    try {
      await KeysApi.switchModel({ provider: model.provider, modelId: model.id })
      setCurrentModel(modelKey)
    } catch (e) { setError(e instanceof Error ? e.message : '模型切换失败，请重试') } finally {
      operationLock.current = false
      setSwitching('')
    }
  }

  const verifyModel = async (model: Model) => {
    if (operationLock.current) return
    operationLock.current = true; setVerifying(`${model.provider}/${model.id}`); setError('')
    try {
      await KeysApi.verify({ provider: model.provider, modelId: model.id })
      await refreshModels()
    } catch (e) { setError(e instanceof Error ? e.message : '验证失败，请重试') }
    finally { operationLock.current = false; setVerifying('') }
  }

  const resetFilters = () => {
    setQuery('')
    setFacets({ free: false, reasoning: false, vision: false })
    setFilter('all')
  }

  return (
    <div className="flex-1 overflow-y-auto relative z-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
        <PageHeader
          title="模型中心"
          description="查看当前选择，筛选合适模型，并在需要时切换。"
          meta={`${models.length} 个模型 · ${freeCount} 免费 · 工作空间 ${cwd ? cwd.split(/[\\/]/).pop() : '—'}`}
        />

        <ActiveModelHero currentModel={currentModel} model={activeModel} />
        <ModelChannels />
        {error && <p role="alert" className="text-sm text-pi-danger mb-4">{error}</p>}
        <p className="text-sm text-pi-dim mb-4">目录不代表可调用。点击「验证文本」会发起一次真实短文本请求，可能产生少量费用；不会验证工具、视觉或生成媒体。</p>

        <ModelFilterBar
          type={filter}
          query={query}
          facets={facets}
          freeFirst={freeFirst}
          switching={Boolean(switching)}
          onTypeChange={setFilter}
          onQueryChange={setQuery}
          onFacetChange={facet => setFacets(current => ({ ...current, [facet]: !current[facet] }))}
          onFreeFirstChange={setFreeFirst}
        />

        <section data-slot="model-results" aria-label="模型结果">
          <div className="flex items-center justify-between gap-3 mb-3 text-[12px] text-pi-dim2">
            <span>{filtering ? `筛出 ${visibleModels.length} / ${models.length} 个模型` : `${models.length} 个已配置模型`}</span>
            <span>点击卡片按钮即可切换</span>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 mb-8">
            {visibleModels.map(model => {
              const modelKey = `${model.provider}/${model.id}`
              return <ModelCard key={modelKey} model={model} active={currentModel === modelKey} switching={switching === modelKey} onUse={() => useModel(model)} verifying={verifying === modelKey} busy={Boolean(switching || verifying)} onVerify={() => verifyModel(model)} />
            })}
            {!visibleModels.length && (
              <EmptyState icon={EmptySearchIcon} title="没有符合条件的模型" hint="试试清空搜索词或取消能力筛选" className="col-span-full"
                action={{ label: '重置筛选', onClick: resetFilters }} />
            )}
          </div>
        </section>

        <details className="panel !p-0 overflow-hidden mb-6">
          <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between gap-3">
            <span className="text-[13px] font-semibold text-pi-text">用量统计</span>
            <span className="text-[11px] text-pi-dim2 font-normal">每 60s 刷新 · 点击展开</span>
          </summary>
          <div className="border-t border-pi-border-soft p-3 sm:p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {!stats ? [0, 1, 2].map(index => (
                <div key={index} className="stat-card">
                  <div className="h-6 rounded-pi-sm skeleton-block w-16" />
                  <div className="h-2.5 rounded-pi-sm skeleton-block w-12 mt-2" />
                </div>
              )) : <>
                <div className="stat-card"><div className="stat-num text-pi-text">{fmtCost(totalCost)}</div><div className="text-[11px] text-pi-dim2 mt-0.5">累计成本</div></div>
                <div className="stat-card"><div className="stat-num text-pi-text">{totalMessages.toLocaleString()}</div><div className="text-[11px] text-pi-dim2 mt-0.5">累计消息</div></div>
                <div className="stat-card"><div className="stat-num text-pi-success">{freeCount}<span className="text-[13px] text-pi-dim2 font-medium"> / {models.length}</span></div><div className="text-[11px] text-pi-dim2 mt-0.5">免费通道</div></div>
              </>}
            </div>

            <section className="rounded-pi-lg border border-pi-border overflow-hidden" aria-labelledby="provider-usage-title">
              <div className="px-4 py-3">
                <h2 id="provider-usage-title" className="text-[13px] font-semibold text-pi-text">Provider 用量</h2>
              </div>
              <ProviderUsageTable providers={providers} />
            </section>
          </div>
        </details>

        <p className="text-sm text-pi-dim">验证结果仅记录该次请求，服务商限流、余额和权限变化仍可能影响后续调用。</p>
      </div>
    </div>
  )
}
