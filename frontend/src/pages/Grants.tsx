import { useEffect, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useApp } from '../store'
import PageHeader from '../components/PageHeader'
import { Block, LoadState, date } from '../soul/shared'
import { Confirmations, SessionChoice } from '../soul/Confirmations'
import { CultivationApi, cultivationPolling, type Overview } from '../soul/cultivation/api'
import Resources from '../soul/cultivation/Resources'
import Authorization, { type Action } from '../soul/cultivation/Authorization'
import { KnowledgeApi, knowledgePolling } from '../knowledge/api'
import KnowledgePolicy from '../knowledge/KnowledgePolicy'
import SandboxModePanel from '../components/engine/SandboxModePanel'
import ComputerUsePanel from '../components/ComputerUsePanel'
import '../soul/soul.css'
import '../soul/cultivation/cultivation.css'

// 授权中心：所有「放权 / 提权 / 批准」按钮的唯一集合处。
// 各面板仍是原来那一份组件（同一套判据与确认流程），这里只负责把它们放到一起，
// 原页面上的入口保留——就近操作还在，找不到时来这里。
const AREAS = [
  ['pending', '等我确认', '小语发起、需要你点头的操作都排在这里。'],
  ['cultivation', '培养与母体学习', '智能体培养的一次性放权、母体自主采用经验、共享模型与额度。'],
  ['knowledge', '知识自动积累', '允许读取的目录与网址、能否联网、可用模型与每日额度。'],
  ['session', '本会话执行权限', '沙箱、超维模式与维护模式：决定当前会话能动哪些文件和命令。'],
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
    <LoadState error={overview.error} loading={overview.isLoading} retry={() => overview.mutate()} />
    {action && <Authorization key={JSON.stringify([sessionId, action])} action={action} owner={overview.data?.ownerConfirmation} sessionId={sessionId}
      sessionGrantAvailable={!!overview.data?.sessionGrantAvailable} close={() => setAction(null)} refresh={refresh} />}
    {overview.data && <Block title="培养授权与资源"><Resources value={overview.data} sessionId={sessionId} onAction={setAction} refresh={refresh} /></Block>}
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
        <label className="soul-mobile-nav">授权分区<select value={area} onChange={e => setArea(e.target.value as Area)}>
          {AREAS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <main className="soul-workarea">
          <header className="soul-section-heading"><h2>{current[1]}</h2><p>{current[2]}</p></header>
          {(area === 'pending' || area === 'cultivation' || area === 'session') && <SessionChoice sessionId={sessionId} setSessionId={setSessionId} disabled={false} />}
          {area === 'pending' && <>
            <Confirmations sessionId={sessionId} active busy={false} />
            <p className="soul-hint">没有卡片就是没有待确认的事。性格基因的变更提案在「灵魂培养 · 性格基因」里发起，批准请求也会出现在这里。</p>
          </>}
          {area === 'cultivation' && <CultivationGrants sessionId={sessionId} />}
          {area === 'knowledge' && <KnowledgeGrants />}
          {area === 'session' && <SandboxModePanel sessionId={sessionId} />}
          {area === 'desktop' && <ComputerUsePanel />}
        </main>
      </div>
    </div>
  </div>
}
