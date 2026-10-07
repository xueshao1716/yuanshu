import { useState } from 'react'
import useSWR from 'swr'
import type { Overview } from './api'
import type { Action } from './Authorization'
import { KnowledgeApi, knowledgePolling } from '../../knowledge/api'
import { errorText } from '../shared'
import { widenPolicy, sharedRequestPatch, type WidenKey } from './grant-preset.mjs'

// 2026-10-07 伙伴「给被培养的智能体更大权限，时间更长，额度更大」。
// 授权已开启时就地放大时间与额度；模型、工具、数据范围、母体学习不动。仍走主人确认，不能由小语自己点。
const LABELS: Record<WidenKey, [string, (v: any) => string]> = {
  maxAgents: ['个体上限', v => `${v ?? 1} 个`],
  dailyRequests: ['每天请求', v => `${v ?? 0} 次`],
  dailyBudgetCents: ['每天预算', v => `${((v ?? 0) / 100).toFixed(2)} 美元`],
  timeoutMs: ['单次超时', v => { const s = Math.round((v ?? 60000) / 1000); return s >= 60 && s % 60 === 0 ? `${s / 60} 分钟` : `${s} 秒` }],
  expiresAt: ['到期', v => v ? new Date(v).toLocaleDateString('zh-CN') : '未设置'],
}

export default function WidenCard({ value, authorized, onAction, refresh }: { value: Overview; authorized: boolean; onAction: (a: Action) => void; refresh: () => Promise<unknown> }) {
  const knowledge = useSWR('knowledge-policy', KnowledgeApi.policy, knowledgePolling)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const widen = widenPolicy(value.policy)
  const shared = sharedRequestPatch(knowledge.data)
  if (!widen && !shared) return null
  const fixShared = async () => {
    if (!shared || !knowledge.data) return
    setBusy(true); setError('')
    try { await KnowledgeApi.updatePolicy(shared, knowledge.data.revision); await knowledge.mutate(); await refresh() }
    catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section aria-label="加大额度" className="soul-notice">
    <h4>加大培养额度</h4>
    {widen && <>
      <dl className="soul-facts">{widen.changed.map(k => <div key={k}><dt>{LABELS[k][0]}</dt>
        <dd>{LABELS[k][1](value.policy[k])} → <strong>{LABELS[k][1](widen.policy[k])}</strong></dd></div>)}</dl>
      <p className="soul-hint">只放大时间和额度。模型、工具、数据范围不变，仍不含电脑、文件、密码或私人记忆。</p>
      <div className="soul-actions"><button className="soul-primary" disabled={!authorized} onClick={() => onAction({ method: 'PUT', path: '/policy', revision: value.revision,
        label: '加大培养额度', payload: { policy: widen.policy } })}>加大额度</button></div>
      {!authorized && <p className="soul-hint">先在上方选择会话，再确认。</p>}
    </>}
    {shared && <>
      <p>知识与培养共用的每日模型调用只有 {knowledge.data?.maxModelRequests} 次，会先于培养额度用完。建议调到 {shared.maxModelRequests} 次（免费模型不产生费用）。</p>
      <div className="soul-actions"><button disabled={busy} onClick={() => void fixShared()}>{busy ? '正在调整…' : `共享调用调到 ${shared.maxModelRequests} 次`}</button></div>
      {error && <p role="alert">调整失败：{error}</p>}
    </>}
  </section>
}
