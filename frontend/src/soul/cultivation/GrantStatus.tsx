import type { Overview } from './api'
import type { Action } from './Authorization'
import { date } from '../shared'
import { grantSummary } from './grant-preset.mjs'

export function grantState(v: Overview) {
  const expiry = v.policy.expiresAt ? Date.parse(v.policy.expiresAt) : NaN
  if (!v.policy.enabled) return 'off' as const
  if (Number.isFinite(expiry) && expiry <= Date.now()) return 'expired' as const
  return 'on' as const
}

// 授权只回答三件事：现在开没开、用了多少、怎么收回。其余细节都在「高级设置」。
export default function GrantStatus({ value, onAction }: { value: Overview; onAction: (a: Action) => void }) {
  const state = grantState(value)
  const label = { on: '已放权', off: '未放权', expired: '已过期' }[state]
  return <section aria-label="培养授权状态" className="grant-status">
    <p className={`soul-notice grant-status__${state}`} role="status"><strong>{label}</strong>
      {state === 'on' && <> · 到期 {date(value.policy.expiresAt)}</>}
      {state !== 'on' && <> · 小语在对话里说一声就会自己开启；也可以在下面手动放权</>}</p>
    <dl className="soul-facts">
      <div><dt>今日已用</dt><dd>{value.usage ? `${value.usage.spent} ${value.usage.currency} · ${value.usage.modelRequests} 次` : '—'}</dd></div>
      <div><dt>上限</dt><dd>每天 {value.policy.dailyRequests} 次 · {(value.policy.dailyBudgetCents / 100).toFixed(2)} 美元</dd></div>
      <div><dt>个体上限</dt><dd>{value.policy.maxAgents} 个</dd></div>
    </dl>
    <p className="soul-hint">放权范围：{grantSummary}。只做纯文本培养，不含电脑、文件、密码、工具或私人记忆。</p>
    {state === 'on' && <div className="soul-actions">
      <button onClick={() => onAction({ method: 'PUT', path: '/policy', revision: value.revision, label: '收回培养授权',
        payload: { policy: { ...value.policy, enabled: false, motherLearning: false } } })}>收回培养授权</button>
    </div>}
  </section>
}
