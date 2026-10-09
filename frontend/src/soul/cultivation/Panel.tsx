import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { Block, LoadState, date, errorText } from '../shared'
import { CultivationApi, cultivationPolling, statusLabel, type Agent, type Design, type Run, type Experience } from './api'
import Learning from './Learning'
import type { Action } from './Authorization'
import Authorization from './Authorization'
import PolicyPreset from './PolicyPreset'
import { queueDraft } from '../../components/xiaoyu/companion-draft.mjs'
import './cultivation.css'

export default function Cultivation({sessionId}:{sessionId:string}) {
  const [expandDesign, setExpandDesign] = useState<string|null>(null)
  const [expandRun, setExpandRun] = useState<boolean>(false)
  const [expandExperience, setExpandExperience] = useState<boolean>(false)
  const [action, setAction] = useState<Action|null>(null)
  const [error, setError] = useState('')
  const {mutate} = useSWRConfig()

  const overview = useSWR('cultivation-overview', CultivationApi.overview, cultivationPolling)
  const agents = useSWR('cultivation-agents', () => CultivationApi.list<Agent>('agents', null), cultivationPolling)
  const [designCursor, setDesignCursor] = useState<string|null>(null)
  const designs = useSWR(['cultivation-designs', designCursor], () => CultivationApi.list<Design>('designs',designCursor), cultivationPolling)
  const runs = useSWR('cultivation-runs', () => CultivationApi.list<Run>('runs', null), cultivationPolling)
  const experience = useSWR('cultivation-experience', () => CultivationApi.list<Experience>('experience', null), cultivationPolling)

  const authorized=!!overview.data?.humanGrantAvailable
  const policyAuthorized = !!overview.data?.humanGrantAvailable || (!!overview.data?.sessionGrantAvailable && !!sessionId)

  const refresh = async () => {
    await mutate(key => typeof key === 'string'
      ? key.startsWith('cultivation-')
      : Array.isArray(key) && String(key[0]).startsWith('cultivation-'))
  }
  const retry = async (fn: () => Promise<unknown>) => {
    setError('')
    try { await fn() } catch(e) { setError(errorText(e)) }
  }

  const designsReversed = [...(designs.data?.items || [])].reverse()
  const agentMap = new Map((agents.data?.items || []).map(a => [a.id, a]))
  const designMap = new Map(designsReversed.map(d => [d.id, d]))

  // 按血缘分组：找出所有根设计（parentId=null），以及它们的后代
  const roots = designsReversed.filter(d => !d.parentId)
  const lineages = roots.map(root => {
    const line = [root]
    let current = root
    while (true) {
      const child = designsReversed.find(d => d.parentId === current.id)
      if (!child) break
      line.push(child)
      current = child
    }
    return line
  })

  const unregistered = designsReversed.filter(d => ![...agentMap.values()].some(a => a.designId === d.id))
  const activeRuns = (runs.data?.items || []).filter(r => ['queued','running'].includes(r.status))
  const pendingExp = (experience.data?.items || []).filter(e => e.state === 'review_required')

  const needsAttention = unregistered.length + activeRuns.length + pendingExp.length

  const sendToChat = (text: string) => {
    if (!sessionId || !queueDraft(sessionStorage, sessionId, text.trim())) {
      alert('暂存失败，请手动复制文字到对话')
      return
    }
    window.dispatchEvent(new Event('yuanshu-companion-draft'))
    window.location.hash = '/chat'
  }

  return <div className="cultivation-panel">
    <Block title="小语的培养工作室" hint="小语自己设计和培养子智能体，你只需查看方案并放权。不需要电脑密码。">
      <LoadState error={overview.error} loading={overview.isLoading} retry={() => retry(overview.mutate)}/>
      {overview.data && (
        <>
          <p className="soul-notice">
            {overview.data.state === 'waiting_for_design' && '等待小语提交设计'}
            {overview.data.state === 'designs_available' && !agentMap.size && '有设计稿，还没登记个体'}
            {overview.data.state === 'designs_available' && agentMap.size > 0 && `培养中 · ${agentMap.size} 个个体`}
          </p>
          <dl className="soul-facts">
            <div><dt>设计稿</dt><dd>{designsReversed.length} 份</dd></div>
            <div><dt>已登记个体</dt><dd>{agentMap.size} 个</dd></div>
            <div><dt>授权到期</dt><dd>{overview.data.policy.expiresAt ? date(overview.data.policy.expiresAt) : '未设置'}</dd></div>
            <div><dt>今日已用</dt><dd>{overview.data.usage ? `${overview.data.usage.spent} ${overview.data.usage.currency}` : '—'}</dd></div>
          </dl>
        </>
      )}
    </Block>

    {needsAttention > 0 && (
      <Block title={`等你点头（${needsAttention}）`} hint="她设计好了，需要你确认">
        {unregistered.length > 0 && (
          <details open>
            <summary>未登记的设计稿（{unregistered.length}）</summary>
            <ul className="cultivation-list">
              {unregistered.map(d => (
                <li key={d.id}>
                  <h4>{d.design.name}</h4>
                  <p className="soul-dim">{d.design.rationale}</p>
                  <button onClick={() => sendToChat(`请登记「${d.design.name}」设计稿（${d.id.slice(0,8)}）`)}>
                    让小语登记
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
        {activeRuns.length > 0 && (
          <details>
            <summary>运行中的任务（{activeRuns.length}）</summary>
            <ul className="cultivation-list">
              {activeRuns.map(run => {
                const agent = agentMap.get(run.cultivation.agentId)
                const design = designMap.get(agent?.designId || '')
                return (
                  <li key={run.id}>
                    <h4>{design?.design.name || '未知个体'} · {statusLabel(run.status)}</h4>
                    <p className="soul-dim">{date(run.createdAt)}</p>
                    <button onClick={() => setAction({
                      method: 'POST', path: `/runs/${run.id}/cancel`,
                      payload: {}, revision: overview.data!.revision, label: '取消任务'
                    })}>叫停这个任务</button>
                  </li>
                )
              })}
            </ul>
          </details>
        )}
        {pendingExp.length > 0 && (
          <details>
            <summary>待核查经验（{pendingExp.length}）</summary>
            <p className="soul-hint">展开「反哺的经验」查看详情并处理</p>
          </details>
        )}
      </Block>
    )}

    {action && (
      <Authorization
        key={JSON.stringify([sessionId,action])}
        action={action}
        owner={overview.data?.ownerConfirmation}
        sessionId={sessionId}
        sessionGrantAvailable={!!overview.data?.sessionGrantAvailable}
        close={() => setAction(null)}
        refresh={refresh}
      />
    )}

    <Block title="个体与设计" hint="按血缘分组，最新版优先">
      <LoadState error={designs.error || agents.error} loading={designs.isLoading || agents.isLoading}
        retry={() => { retry(designs.mutate); retry(agents.mutate) }} />
      {lineages.map((line, i) => {
        const latest = line[line.length - 1]
        const agent = [...agentMap.values()].find(a => line.some(d => d.id === a.designId))
        const isExpanded = expandDesign === latest.id
        return (
          <details key={i} open={isExpanded} onToggle={e => setExpandDesign(e.currentTarget.open ? latest.id : null)}>
            <summary>
              <strong>{latest.design.name}</strong>
              {agent && <span className="cultivation-badge">{statusLabel(agent.status)}</span>}
              <span className="soul-dim">· {line.length} 版本</span>
            </summary>
            <div className="cultivation-design">
              <p>{latest.design.rationale}</p>
              <dl className="soul-facts">
                <div><dt>模型</dt><dd>{latest.design.permissions.model}</dd></div>
                <div><dt>单次上限</dt><dd>{latest.design.permissions.costUpperBoundCents} 美分</dd></div>
                <div><dt>联网</dt><dd>{latest.design.permissions.remote ? '是' : '否'}</dd></div>
                <div><dt>工具</dt><dd>{latest.design.permissions.tools.length || '无'}</dd></div>
              </dl>
              <h4>目标</h4>
              <ul>{latest.design.goals.map((g,i) => <li key={i}>{g}</li>)}</ul>
              <h4>课程</h4>
              <ol>{latest.design.curriculum.map((c,i) => <li key={i}>{c}</li>)}</ol>
              {line.length > 1 && (
                <details>
                  <summary>历史版本（{line.length - 1}）</summary>
                  <ol>
                    {line.slice(0, -1).reverse().map(d => (
                      <li key={d.id}>
                        <small>{d.design.name} · {d.id.slice(0,8)}</small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {agent && (
                <div className="soul-actions">
                  {(agent.status === 'archived' ? [] : agent.status === 'paused' ? ['resume','archive'] : ['pause','archive']).map(act => (
                    <button key={act} disabled={!authorized} title={authorized ? '' : '需要人工签名通道'}
                      onClick={() => setAction({
                        method: 'POST', path: `/agents/${agent.id}/${act}`,
                        payload: {}, revision: overview.data!.revision,
                        label: {pause:'暂停个体',resume:'恢复个体',archive:'归档个体'}[act]!
                      })}>
                      {{pause:'暂停',resume:'恢复',archive:'归档'}[act]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </details>
        )
      })}
      {!lineages.length && <p className="soul-hint">还没有设计稿</p>}
    </Block>

    <details open={expandRun} onToggle={e => setExpandRun(e.currentTarget.open)}>
      <summary><strong>运行时间线</strong> · {runs.data?.items.length || 0} 条</summary>
      <LoadState error={runs.error} loading={runs.isLoading} retry={() => retry(runs.mutate)} />
      {runs.data && !runs.data.items.length && <p className="soul-hint">还没有运行记录</p>}
      <ol className="cultivation-list">
        {(runs.data?.items || []).map(run => {
          const agent = agentMap.get(run.cultivation.agentId)
          const design = designMap.get(agent?.designId || '')
          return (
            <li key={run.id}>
              <h4>{design?.design.name || '未知个体'} · {statusLabel(run.status)}</h4>
              <p className="soul-dim">{date(run.createdAt)}</p>
              {run.cultivation.reason && <p>{run.cultivation.reason}</p>}
              {run.cultivation.output && (
                <details>
                  <summary>输出</summary>
                  <p className="cultivation-output">{run.cultivation.output}</p>
                </details>
              )}
              {run.error?.message && <p role="alert">{run.error.message}</p>}
            </li>
          )
        })}
      </ol>
    </details>

    <details open={expandExperience} onToggle={e => setExpandExperience(e.currentTarget.open)}>
      <summary><strong>学习证据</strong> · {experience.data?.items.length || 0} 条</summary>
      <LoadState error={experience.error} loading={experience.isLoading} retry={() => retry(experience.mutate)} />
      {experience.data && (
        <Learning
          items={experience.data.items}
          coverage={experience.data.coverage}
          stale={!!experience.error}
          authorized={authorized}
          onAction={setAction}
        />
      )}
    </details>

    {overview.data && (
      <Block title="授权与资源" hint={policyAuthorized ? '已放权，小语可以自主跑任务' : '还没放权，需要一次性同意'}>
        {!policyAuthorized && overview.data.sessionGrantAvailable && !sessionId && (
          <p className="soul-notice">请先在页面上方选择会话，就可以一键同意</p>
        )}
        <PolicyPreset value={overview.data} authorized={policyAuthorized} onAction={setAction} refresh={refresh} />
      </Block>
    )}

    {error && <p role="alert" className="soul-notice">{error}</p>}
  </div>
}
