import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { Block, LoadState, date, errorText } from '../shared'
import { CultivationApi, cultivationPolling, statusLabel, type Agent, type Design, type Run, type Experience } from './api'
import Individuals from './Individuals'
import Resources from './Resources'
import Learning from './Learning'
import Authorization, { type Action } from './Authorization'
import './cultivation.css'

// Tab 顺序：小语的工作区优先，授权降到最后
const tabs = [
  ['agents',     '设计稿与个体',  '小语设计的 agent 方案和已登记的个体'],
  ['runs',       '运行记录',      '任务队列、运行状态与输出'],
  ['experience', '学习证据',      '反馈给小语的经验，带来源和核验状态'],
  ['resources',  '授权',          '放权与资源设置（偶尔用）'],
] as const
type Tab = typeof tabs[number][0]

export default function Cultivation({sessionId}:{sessionId:string}) {
  const [tab, setTab] = useState<Tab>('agents')
  const [cursor, setCursor] = useState<string|null>(null)
  const [action, setAction] = useState<Action|null>(null)
  const [designCursor, setDesignCursor] = useState<string|null>(null)
  const [error, setError] = useState('')
  const {mutate} = useSWRConfig()

  const overview = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const authorized = !!overview.data?.humanGrantAvailable
  const policyAuthorized = !!overview.data?.humanGrantAvailable || (!!overview.data?.sessionGrantAvailable && !!sessionId)

  // 设计稿与个体始终加载（首屏就需要）
  const agents  = useSWR(['cultivation-agents', cursor],       () => CultivationApi.list<Agent>('agents', cursor),     cultivationPolling)
  const designs = useSWR(['cultivation-designs', designCursor],() => CultivationApi.list<Design>('designs', designCursor), cultivationPolling)
  const runs    = useSWR(tab === 'runs'       ? ['cultivation-runs', cursor]       : null, () => CultivationApi.list<Run>('runs', cursor),           cultivationPolling)
  const experience = useSWR(tab === 'experience' ? ['cultivation-experience', cursor] : null, () => CultivationApi.list<Experience>('experience', cursor), cultivationPolling)

  const refresh = async () => {
    await mutate(key => typeof key === 'string'
      ? key.startsWith('cultivation-')
      : Array.isArray(key) && String(key[0]).startsWith('cultivation-'))
  }
  const retry = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn() } catch(e) { setError(errorText(e)) }
  }

  const activeRuns = (runs.data?.items || []).filter(r => ['queued','running'].includes(r.status)).length

  return <div className="cultivation-panel">

    {/* ── 状态摘要：进来先看全局 ── */}
    <Block title="小语的培养空间" hint="她自己设计和培养子智能体，你负责看方案、点头。">
      <LoadState error={overview.error} loading={overview.isLoading} retry={() => retry(overview.mutate)}/>
      {overview.data && (
        <dl className="soul-facts">
          <div><dt>设计稿</dt><dd>{designs.data?.items.length ?? '…'} 份</dd></div>
          <div><dt>已登记个体</dt><dd>{agents.data?.items.length ?? '…'} 个</dd></div>
          <div><dt>培养授权</dt><dd>
            {overview.data.policy.enabled
              ? (overview.data.policy.expiresAt
                  ? `有效至 ${new Date(overview.data.policy.expiresAt).toLocaleDateString('zh-CN')}`
                  : '已开启')
              : '未开启'}
          </dd></div>
          <div><dt>母体学习</dt><dd>{overview.data.policy.motherLearning ? '已授权' : '未授权'}</dd></div>
        </dl>
      )}
      {overview.data?.state === 'waiting_for_design' && (
        <p className="soul-notice">等待小语提交设计稿——你们在对话里协作好后，她会把方案提交到这里。</p>
      )}
      {!policyAuthorized && overview.data && (
        <p className="soul-hint">还没放权。去「授权」Tab 选一个会话并同意，小语才能开始跑任务。</p>
      )}
    </Block>

    {/* ── Tab 导航 ── */}
    <div className="soul-actions" role="tablist" aria-label="培养分区">
      {tabs.map(([id]) => (
        <button key={id} role="tab" aria-selected={tab === id}
          onClick={() => { setTab(id as Tab); setCursor(null); setAction(null); setError('') }}>
          {tabs.find(([k]) => k === id)![1]}
          {id === 'runs' && activeRuns > 0 && <span className="cultivation-badge">{activeRuns}</span>}
        </button>
      ))}
      <button onClick={() => { setCursor(null); setDesignCursor(null); void retry(refresh) }}>刷新</button>
    </div>
    {error && <p role="alert" className="soul-notice">刷新失败：{error}</p>}

    {/* ── 授权操作：只在申请发起时浮出 ── */}
    {action && (
      <Authorization
        key={JSON.stringify([sessionId, action])}
        action={action}
        owner={overview.data?.ownerConfirmation}
        sessionId={sessionId}
        sessionGrantAvailable={!!overview.data?.sessionGrantAvailable}
        close={() => setAction(null)}
        refresh={refresh}
      />
    )}

    {/* ── 设计稿与个体 ── */}
    {tab === 'agents' && (
      <Block title="设计稿与个体" hint="小语提交的方案在这里；你可以直接改设计稿，也可以在对话里跟她协商。">
        <LoadState error={designs.error} loading={designs.isLoading} retry={() => { setDesignCursor(null); return retry(designs.mutate) }}/>
        <LoadState error={agents.error}  loading={agents.isLoading}  retry={() => { setCursor(null);       return retry(agents.mutate) }}/>
        <Individuals agents={agents.data?.items || []} designs={designs.data?.items || []} authorized={authorized} onAction={setAction}/>
        <div className="soul-actions">
          <button disabled={!designCursor} onClick={() => setDesignCursor(null)}>设计第一页</button>
          <button disabled={!designs.data?.nextCursor} onClick={() => setDesignCursor(designs.data?.nextCursor || null)}>下一页设计</button>
        </div>
      </Block>
    )}

    {/* ── 运行记录 ── */}
    {tab === 'runs' && (
      <Block title="运行记录" hint="任务由小语发起，跑完结果会反馈给她；你可以随时叫停。">
        <LoadState error={runs.error} loading={runs.isLoading} retry={() => { setCursor(null); return retry(runs.mutate) }}/>
        {runs.data && <>
          {!runs.data.items.length && <p className="soul-hint">还没有运行记录。</p>}
          <ol className="cultivation-list">
            {runs.data.items.map(run => (
              <li key={run.id}>
                <h4>{statusLabel(run.status)} · {date(run.createdAt)}</h4>
                <p className="soul-dim">个体 {run.cultivation.agentId} · 设计 {run.cultivation.designId}</p>
                {run.cultivation.reason && <p>{run.cultivation.reason}</p>}
                {run.cultivation.output && (
                  <details>
                    <summary>任务输出</summary>
                    <p className="cultivation-output">{run.cultivation.output}</p>
                  </details>
                )}
                {['queued','running'].includes(run.status) && (
                  <button onClick={() => setAction({
                    method: 'POST', path: `/runs/${run.id}/cancel`,
                    payload: {}, revision: overview.data!.revision, label: '取消任务'
                  })}>叫停这个任务</button>
                )}
              </li>
            ))}
          </ol>
          <div className="soul-actions">
            <button disabled={!cursor} onClick={() => setCursor(null)}>第一页</button>
            <button disabled={!runs.data.nextCursor} onClick={() => setCursor(runs.data!.nextCursor || null)}>下一页</button>
          </div>
        </>}
      </Block>
    )}

    {/* ── 学习证据 ── */}
    {tab === 'experience' && (
      <Block title="学习证据" hint="这里的经验会反馈给小语，带来源和核验状态。">
        <LoadState error={experience.error} loading={experience.isLoading} retry={() => { setCursor(null); return retry(experience.mutate) }}/>
        {experience.data && <>
          <Learning items={experience.data.items} coverage={experience.data.coverage} stale={!!experience.error} authorized={authorized} onAction={setAction}/>
          <div className="soul-actions">
            <button disabled={!cursor} onClick={() => setCursor(null)}>第一页</button>
            <button disabled={!experience.data.nextCursor} onClick={() => setCursor(experience.data!.nextCursor || null)}>下一页</button>
          </div>
        </>}
      </Block>
    )}

    {/* ── 授权（折叠在最后，偶尔用）── */}
    {tab === 'resources' && overview.data && (
      <Block
        title="授权"
        hint={policyAuthorized ? '已放权，小语可以自主跑任务。' : '还没放权，选一个会话并同意即可。'}
      >
        {!policyAuthorized && overview.data.sessionGrantAvailable && !sessionId && (
          <p className="soul-notice">请先在页面上方「选择会话」，选一个活跃会话，就可以在这里一键同意。</p>
        )}
        <Resources value={overview.data} sessionId={sessionId} onAction={setAction} refresh={refresh}/>
      </Block>
    )}

  </div>
}
