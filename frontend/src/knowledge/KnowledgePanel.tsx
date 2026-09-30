import { useState } from 'react'
import useSWR from 'swr'
import { KnowledgeApi, knowledgePolling, knowledgeError, knowledgeReason } from './api'
import KnowledgePolicy from './KnowledgePolicy'
import KnowledgeJobs from './KnowledgeJobs'
import KnowledgeSource from './KnowledgeSource'

export default function KnowledgePanel() {
  const status = useSWR('knowledge-status', KnowledgeApi.status, knowledgePolling)
  const policy = useSWR('knowledge-policy', KnowledgeApi.policy, { refreshWhenHidden: false })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const refreshed = async () => { await Promise.allSettled([status.mutate(), policy.mutate()]) }
  const counts = status.data?.summary.counts, budget = status.data?.budget
  return <section className="panel min-w-0 space-y-4 text-[13px] text-pi-text" aria-label="知识自动积累">
    <div className="flex flex-wrap justify-between items-center gap-3">
      <h3 className="font-semibold text-[15px]">知识自动积累</h3>
      <div className="flex flex-wrap gap-2">
        <button className="btn-tool min-h-11 px-3" disabled={status.isValidating || policy.isValidating} onClick={() => void refreshed()}>刷新状态</button>
        {policy.data && <button className="btn-tool min-h-11 px-3 disabled:opacity-50" disabled={busy} onClick={async () => {
          setBusy(true); setError('')
          try {await KnowledgeApi.updatePolicy({paused:!policy.data!.paused},policy.data!.revision)} catch (e) {setError(knowledgeError(e))}
          finally {await refreshed(); setBusy(false)}
        }}>{busy ? '正在更新…' : policy.data.paused ? '恢复自动处理' : '暂停自动处理'}</button>}
      </div>
    </div>
    <p className="text-pi-dim leading-6">任务结束后自动登记，空闲时提炼；有来源才入库，有实际引用才计为使用。待核查内容不会当作事实注入聊天。</p>
    {(status.isLoading || policy.isLoading) && <p role="status">正在读取知识状态…</p>}
    {(error || status.error || policy.error) && <p role="alert">{error || knowledgeError(status.error || policy.error)}</p>}
    {status.data && <div className="space-y-2 leading-6">
      <p>{status.data.summary.paused ? '自动处理已暂停' : status.data.worker.running ? '正在处理一项知识任务' : '后台等待空闲处理'} · 已入库 {counts?.committed || 0} · 待核查 {counts?.review_required || 0} · 等待条件 {counts?.blocked || 0} · 已由补证解决 {counts?.resolved || 0}</p>
      {budget && <p className="text-pi-dim tabular-nums">今日已计费 {budget.spent.toFixed(4)} {budget.currency} · 预留 {budget.reserved.toFixed(4)} {budget.currency} · 用量未知 {budget.unknown} 次<br />模型请求 {budget.modelRequests} 次 · 网页请求 {budget.networkRequests} 次（{budget.day} UTC）</p>}
      {!!status.data.worker.cooldownUntil && status.data.worker.cooldownUntil > Date.now() && <p>连续请求失败，冷却至 {new Date(status.data.worker.cooldownUntil).toLocaleTimeString('zh-CN')}。</p>}
      {(status.data.lastError || status.data.worker.lastError) && <p role="alert">{knowledgeReason(status.data.lastError || status.data.worker.lastError)}</p>}
      {status.data.intake?.lastError && <p role="alert">资料登记未完成：{knowledgeReason(status.data.intake.lastError)}</p>}
    </div>}
    {policy.data && <><KnowledgeSource revision={policy.data.revision} refreshed={refreshed} /><KnowledgePolicy policy={policy.data} refreshed={refreshed} /></>}
    <KnowledgeJobs policyRevision={policy.data?.revision} refreshed={refreshed} />
  </section>
}
