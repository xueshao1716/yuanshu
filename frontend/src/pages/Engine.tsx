import { useEffect, useRef, useState } from 'react'
import { Activity, Boxes, CheckCircle2, ChevronDown, LoaderCircle, RefreshCw, SlidersHorizontal, SquareTerminal, Wrench, Plug } from 'lucide-react'
import useSWR from 'swr'
import { EngineApi, RunApi } from '../api'
import { useApp } from '../store'
import TerminalPanel from '../components/TerminalPanel'
import PageHeader from '../components/PageHeader'
import EnginePairPanel from '../components/engine/EnginePairPanel'
import EngineTools from '../components/engine/EngineTools'
import EngineGatewayPanels from '../components/engine/EngineGatewayPanels'
import EngineRunDiagnostics from '../components/engine/EngineRunDiagnostics'
import McpPanel from '../components/McpPanel'

export default function Engine({ openMcp = false }: { openMcp?: boolean } = {}) {
  const { currentModel, selectSession } = useApp()
  const { data: status, error: statusError, mutate: mutateStatus, isValidating } = useSWR('engine-status', () => EngineApi.status(), { refreshInterval: 60000 })
  const { data: toolsData, error: toolsError, mutate: mutateTools } = useSWR('engine-tools', () => EngineApi.tools(), { refreshInterval: 60000 })
  const { data: pair, error: pairError, mutate: mutatePair } = useSWR('engine-pair', () => EngineApi.pair(), { refreshInterval: 60000 })
  const { data: runData, error: runError, mutate: mutateRuns } = useSWR('engine-run-overview', () => RunApi.overview(), { refreshInterval: 10000 })
  const mcpRef = useRef<HTMLDetailsElement>(null)
  useEffect(() => { if (openMcp && mcpRef.current) mcpRef.current.open = true }, [openMcp])
  const [refreshing, setRefreshing] = useState(false)
  const refreshingRef = useRef(false)
  const [refreshError, setRefreshError] = useState('')
  const [refreshFailed, setRefreshFailed] = useState<Record<string, boolean>>({})
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [terminalMounted, setTerminalMounted] = useState(false)
  const trackRefresh = async (key: string, request: () => Promise<unknown>) => {
    try {
      const result = await request()
      setRefreshFailed(previous => ({ ...previous, [key]: false }))
      return result
    } catch (error) {
      setRefreshFailed(previous => ({ ...previous, [key]: true }))
      throw error
    }
  }
  const reloadStatus = () => trackRefresh('status', () => mutateStatus(EngineApi.status(), { revalidate: false }))
  const reloadPair = () => trackRefresh('pair', () => mutatePair(EngineApi.pair(), { revalidate: false }))
  const probe = async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true; setRefreshing(true); setRefreshError('')
    try {
      const results = await Promise.allSettled([
        reloadStatus(), reloadPair(),
        trackRefresh('tools', () => mutateTools(EngineApi.tools(), { revalidate: false })),
        trackRefresh('runs', () => mutateRuns(RunApi.overview(), { revalidate: false })),
      ])
      if (results.some(result => result.status === 'rejected')) setRefreshError('部分状态刷新失败，已保留上次数据。')
    } finally { refreshingRef.current = false; setRefreshing(false) }
  }
  const openSession = (id: string) => { selectSession(id); location.hash = '#/chat' }
  const label = (id?: string) => pair?.catalog.find(item => item.id === id)?.label || id || '加载中'
  const activeCount = runData?.active.length ?? 0
  const failedCount = runData?.recent.filter(run => run.status === 'failed' || run.status === 'interrupted').length ?? 0
  const mountedPluginCount = status?.plugins?.filter((plugin: any) => plugin.mounted).length ?? 0
  const toolCount = toolsData?.tools?.length ?? 0
  const runUnavailable = !!(runError || refreshFailed.runs)
  const toolsUnavailable = !!(toolsError || refreshFailed.tools)
  const statusUnavailable = !!(statusError || refreshFailed.status)
  const pairUnavailable = !!(pairError || refreshFailed.pair)
  const primary = pairUnavailable ? '暂不可用' : label(pair?.primary)
  const secondary = pairUnavailable ? '暂不可用' : label(pair?.secondary)
  const health = statusUnavailable ? { label: '状态受限', tone: 'warning' } : runUnavailable ? { label: '观测受限', tone: 'warning' } : failedCount > 0 ? { label: '需要关注', tone: 'danger' } : activeCount > 0 ? { label: '运行中', tone: 'success' } : { label: '系统就绪', tone: 'success' }
  const observation = runUnavailable ? <span className="text-sm text-pi-danger">观测暂不可用</span>
    : !runData ? <span role="status" className="text-sm text-pi-dim">加载中</span>
    : <span className="inline-flex items-center gap-2 text-sm text-pi-text">{runData.active.length ? <LoaderCircle className="w-4 h-4 text-pi-accent animate-spin" /> : <CheckCircle2 className="w-4 h-4 text-pi-success" />}{runData.active.length ? `${runData.active.length} 个任务运行中` : '当前无活动任务'}</span>

  return <div className="flex-1 overflow-y-auto relative z-10 bg-pi-bg">
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
      <PageHeader title="引擎控制台" meta={<div className="flex flex-wrap items-center gap-4">{observation}<span className={`engine-health engine-health-${health.tone}`}><span className="engine-health-dot" />{health.label}</span></div>} actions={
        <button type="button" className="btn-ghost min-h-11" disabled={refreshing} onClick={() => void probe()}><RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />刷新状态</button>
      } />
      {refreshError && <p role="alert" className="text-sm text-pi-danger mb-3">{refreshError}</p>}
      <section className="engine-overview" data-slot="engine-overview">
        <dl className="engine-overview-facts">
          <div className="engine-overview-fact"><dt>配置主驾</dt><dd>{primary}</dd></div>
          <div className="engine-overview-fact"><dt>配置次席</dt><dd>{secondary}</dd></div>
          <div className="engine-overview-fact"><dt>正在运行</dt><dd>{runUnavailable ? '暂不可用' : runData ? `${activeCount} 个任务` : '加载中'}</dd></div>
          <div className="engine-overview-fact"><dt>最近 {runData?.recent.length ?? ''} 次运行异常</dt><dd data-warning={!runUnavailable && failedCount > 0}>{runUnavailable ? '暂不可用' : runData ? `${failedCount} 次` : '加载中'}</dd></div>
        </dl>
        <dl className="engine-model-selection"><dt>当前模型选择</dt><dd>{currentModel === 'auto/auto' ? '自动路由' : currentModel}</dd></dl>
      </section>
      <div className="engine-sections" data-slot="engine-sections">
        <details className="engine-detail" name="engine-section">
          <summary><Boxes aria-hidden="true" /><span className="engine-detail-title">系统如何分工</span><span className="engine-detail-hint">引擎、模型与子智能体</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content text-sm leading-relaxed space-y-3 text-pi-dim">
            <p><strong className="text-pi-text">AIBody 协调层</strong>承接任务主题、身份与记忆，记录角色协作和证据。是否发生了记忆写入或委派，以每轮工作说明为准。</p>
            <p><strong className="text-pi-text">主引擎</strong>控制任务执行、工具调用和恢复；<strong className="text-pi-text">模型</strong>负责理解需求和生成回复。当前配置和某次任务实际使用的引擎、模型可能不同。</p>
            <p><strong className="text-pi-text">子智能体</strong>负责被委派的局部任务，返回结论与依据，由主角色综合。子智能体自评有把握不等于系统检查通过。</p>
            <p>展开下方“运行诊断”，可查看每轮已记录的选择依据、协作、产物和检查结果。没有记录表示尚未观测到，并不表示功能不可用。</p>
          </div>
        </details>
        <details className="engine-detail" name="engine-section">
          <summary><Activity aria-hidden="true" /><span className="engine-detail-title">运行诊断</span><span className="engine-detail-hint">{runUnavailable ? '暂不可用' : runData ? `${runData.recent.length} 次运行记录` : '加载中'}</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content"><EngineRunDiagnostics data={runData} error={runError || refreshFailed.runs} onOpenSession={openSession} /></div>
        </details>
        <details className="engine-detail" name="engine-section">
          <summary><SlidersHorizontal aria-hidden="true" /><span className="engine-detail-title">引擎配置</span><span className="engine-detail-hint">{primary}</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content">
            <EnginePairPanel data={pair} error={pairError || refreshFailed.pair} onReload={reloadPair} />
          </div>
        </details>
        <details className="engine-detail" name="engine-section">
          <summary><Wrench aria-hidden="true" /><span className="engine-detail-title">工具目录</span><span className="engine-detail-hint">{toolsUnavailable ? '暂不可用' : toolsData ? `${toolCount} 个已注册` : '加载中'}</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content"><EngineTools data={toolsData} error={toolsError || refreshFailed.tools} /></div>
        </details>
        <details className="engine-detail" name="engine-section" ref={mcpRef}>
          <summary><Plug aria-hidden="true" /><span className="engine-detail-title">MCP 外部工具</span><span className="engine-detail-hint">桌面控制、文件、截图等外部 server</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content"><McpPanel /></div>
        </details>
        <details className="engine-detail" name="engine-section">
          <summary><Boxes aria-hidden="true" /><span className="engine-detail-title">Gateway 与旁路</span><span className="engine-detail-hint">{statusUnavailable ? '暂不可用' : status ? `${mountedPluginCount} 个插件已挂载` : '加载中'}</span><ChevronDown className="engine-detail-chevron" aria-hidden="true" /></summary>
          <div className="engine-detail-content"><EngineGatewayPanels data={status} error={statusError || refreshFailed.status} onReload={reloadStatus} onProbe={probe} probing={refreshing || isValidating} /></div>
        </details>
      </div>
      <section className="border-t border-pi-border-soft py-5">
        <button type="button" className="btn-ghost min-h-11" aria-expanded={terminalOpen} onClick={() => { setTerminalMounted(true); setTerminalOpen(value => !value) }}><SquareTerminal className="w-4 h-4" />{terminalOpen ? '收起代码模式' : '打开代码模式'}</button>
        {terminalMounted && <div className={terminalOpen ? 'flex h-[520px] max-h-[65vh] mt-3 flex-col border border-pi-border-soft rounded-pi-md overflow-hidden' : 'hidden'}><TerminalPanel /></div>}
      </section>
    </div>
  </div>
}
