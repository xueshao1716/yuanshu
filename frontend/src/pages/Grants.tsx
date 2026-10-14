import ThemedSelect from '../components/ThemedSelect'
import { useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useApp } from '../store'
import PageHeader from '../components/PageHeader'
import { Block, LoadState, date } from '../soul/shared'
import { AllConfirmations, SessionChoice } from '../soul/Confirmations'
import { CultivationApi, cultivationPolling, type Overview } from '../soul/cultivation/api'
import Resources from '../soul/cultivation/Resources'
import SlotRecovery from '../soul/cultivation/SlotRecovery'
import GrantStatus from '../soul/cultivation/GrantStatus'
import PolicyPreset from '../soul/cultivation/PolicyPreset'
import WidenCard from '../soul/cultivation/WidenCard'
import Authorization, { type Action } from '../soul/cultivation/Authorization'
import { KnowledgeApi, knowledgePolling } from '../knowledge/api'
import KnowledgePolicy from '../knowledge/KnowledgePolicy'
import SandboxModePanel from '../components/engine/SandboxModePanel'
import MaintenanceModePanel from '../components/engine/MaintenanceModePanel'
import ComputerUsePanel from '../components/ComputerUsePanel'
import '../soul/soul.css'
import '../soul/cultivation/cultivation.css'

// 授权中心：所有「放权 / 提权 / 批准」按钮的唯一集合处。
// 各面板仍是原来那一份组件（同一套判据与确认流程），这里只负责把它们放到一起，
// 原页面上的入口保留——就近操作还在，找不到时来这里。
const AREAS = [
  ['pending', '等我确认', '全部会话的越线确认都排在这里；常规培养开关她自己执行，不进这里。'],
  ['cultivation', '智能体培养', '开没开、用了多少、怎么收回。开关与额度小语自己管，你随时可以收回。'],
  ['knowledge', '知识自动积累', '允许读取的目录与网址、能否联网、可用模型与每日额度。'],
  ['session', '执行权限', '沙箱模式全局生效，一处设置所有会话共用；超维授权按任务单独批准，需选会话。'],
  ['desktop', '桌面操作', '让小语看屏幕、操作窗口的限时授权，默认关闭。'],
] as const
type Area = typeof AREAS[number][0]

function cultivationState(v?: Overview) {
  if (!v) return '读取中'
  const expiry = v.policy.expiresAt ? Date.parse(v.policy.expiresAt) : NaN
  if (!v.policy.enabled) return '未放权'
  if (Number.isFinite(expiry) && expiry <= Date.now()) return '已过期'
  return v.policy.motherLearning ? '已放权 · 母体学习开' : '已放权 · 母体学习关'
}

function CultivationGrants({ sessionId }: { sessionId: string }) {
  const { mutate } = useSWRConfig()
  const [action, setAction] = useState<Action | null>(null)
  const overview = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const refresh = async () => { await mutate(key => typeof key === 'string' ? key.startsWith('cultivation-') || key.startsWith('knowledge-') : Array.isArray(key) && String(key[0]).startsWith('cultivation-')) }
  return <div className="cultivation-panel">
    <p className="soul-hint">看养了谁、跑成啥样 → <a href="#/soul">灵魂培养 · 智能体培养</a>。</p>
    <LoadState error={overview.error} loading={overview.isLoading} retry={() => overview.mutate()} />
    {action && <Authorization key={JSON.stringify([sessionId, action])} action={action} owner={overview.data?.ownerConfirmation} sessionId={sessionId}
      sessionGrantAvailable={!!overview.data?.sessionGrantAvailable} close={() => setAction(null)} refresh={refresh} />}
    {overview.data && <Block title="培养授权">
      <SlotRecovery value={overview.data} sessionId={sessionId} onAction={setAction} />
      <GrantStatus value={overview.data} onAction={setAction} />
      {!overview.data.policy.enabled && <PolicyPreset value={overview.data} onAction={setAction} refresh={refresh} />}
      <details><summary>高级设置（额度、共享模型、母体学习、签名通道）</summary>
        <WidenCard value={overview.data} authorized onAction={setAction} refresh={refresh} />
        <Resources value={overview.data} sessionId={sessionId} onAction={setAction} refresh={refresh} />
      </details>
    </Block>}
  </div>
}

function KnowledgeGrants() {
  const policy = useSWR('knowledge-policy', KnowledgeApi.policy, knowledgePolling)
  return <Block title="知识授权与限额">
    <LoadState error={policy.error} loading={policy.isLoading} retry={() => policy.mutate()} />
    {policy.data && <>
      <dl className="soul-facts">
        <div><dt>自动处理</dt><dd>{policy.data.paused ? '已暂停' : policy.data.localEnabled ? '开启' : '关闭'}</dd></div>
        <div><dt>联网读取</dt><dd>{policy.data.networkEnabled ? `开启 · ${policy.data.allowedUrls.length} 个网址` : '关闭'}</dd></div>
        <div><dt>允许读取的目录</dt><dd>{policy.data.allowedRoots.length ? `${policy.data.allowedRoots.length} 个` : '未设置（知识缺口只能等你补资料）'}</dd></div>
      </dl>
      <KnowledgePolicy key={policy.data.revision} policy={policy.data} refreshed={() => policy.mutate()} />
    </>}
  </Block>
}

export default function Grants() {
  const { currentSessionId } = useApp()
  const [area, setArea] = useState<Area>('pending')
  const [sessionId, setSessionId] = useState(currentSessionId || '')
  useEffect(() => { if (!sessionId && currentSessionId) setSessionId(currentSessionId) }, [currentSessionId, sessionId])
  const cultivation = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const knowledge = useSWR('knowledge-policy', KnowledgeApi.policy, knowledgePolling)
  const badge: Partial<Record<Area, string>> = {
    cultivation: cultivationState(cultivation.data),
    knowledge: knowledge.data ? (knowledge.data.paused ? '已暂停' : '运行中') : '',
  }
  const current = AREAS.find(a => a[0] === area)!
  return <div className="soul-page">
    <div className="soul-shell">
      <PageHeader title="授权中心" description="放权、提权、批准都在这一页。每一项都能随时收回。"
        meta={cultivation.data?.policy.expiresAt ? <span>培养授权到期：{date(cultivation.data.policy.expiresAt)}</span> : undefined} />
      <div className="soul-layout">
        <nav className="soul-nav" aria-label="授权分区">{AREAS.map(([id, label]) =>
          <button key={id} aria-current={area === id ? 'page' : undefined} onClick={() => setArea(id)}>
            <span>{label}</span>{badge[id] && <small>{badge[id]}</small>}
          </button>)}
        </nav>
        <label className="soul-mobile-nav">授权分区<ThemedSelect value={area} onChange={e => setArea(e.target.value as Area)}>
          {AREAS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</ThemedSelect></label>
        <main className="soul-workarea">
          <header className="soul-section-heading"><h2>{current[1]}</h2><p>{current[2]}</p></header>
          {area !== 'pending' && area === 'cultivation' && <SessionChoice sessionId={sessionId} setSessionId={setSessionId} disabled={false} />}
          {area === 'pending' && <>
            <AllConfirmations />
            <p className="soul-hint">已收全部会话的待确认卡（卡片自带归属对话，不用选）。常规培养开关小语自己执行，不会进这里；出现卡片的就是越线操作，需要你把关。</p>
          </>}
          {area === 'cultivation' && <CultivationGrants sessionId={sessionId} />}
          {area === 'knowledge' && <KnowledgeGrants />}
          {area === 'session' && <div className="space-y-4">
            <SandboxModePanel />
            <SessionChoice sessionId={sessionId} setSessionId={setSessionId} disabled={false} />
            <MaintenanceModePanel sessionId={sessionId} />
          </div>}
          {area === 'desktop' && <ComputerUsePanel />}
        </main>
      </div>
    </div>
  </div>
}
