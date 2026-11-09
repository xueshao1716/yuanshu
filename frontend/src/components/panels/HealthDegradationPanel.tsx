// 退化自评（/api/degradation）——只读
// 五个维度各打一个 0..1 的分，越差越高；总分决定要不要挂闸。这里**只显示**，
// 执行动作是 POST /api/degradation/actions 的事，界面不提供按钮（写开关要人批准，不在这批）。
// 刻意不显示：workspace 绝对路径（那是本机目录，不是用户要读的状态）。
import useSWR from 'swr'
import {
  DEGRADATION_DIMS, DEGRADATION_LABELS, HerApi, actionLabel, finite, levelMeta, percent,
} from '../../lib/her-api'
import { EmptyLine, FailureLine, LoadingLine, Meter, Tag } from '../readout'
import { fmtMsgTime } from '../../lib/fmt-time'

/** 每一维的证据压成一行人话；拿不到证据就返回空串，不编。 */
function evidenceLine(key: string, evidence: Record<string, unknown> = {}) {
  const n = (name: string) => finite(evidence[name])
  // 1,000,000 写成 "1000.0k" 没人读得下去：过百万换 M。
  const tokens = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value)
  if (key === 'competence') {
    if (!('toolCalls' in evidence)) return ''
    const deliveries = (evidence.deliveries || {}) as Record<string, unknown>
    return `工具 ${n('toolCalls')} 次 · 失败 ${n('toolFailures')} · 交付 ${finite(deliveries.total)}（绿 ${finite(deliveries.green)}）`
  }
  if (key === 'hallucination') {
    return 'hitCount' in evidence || 'hits' in evidence ? `反模式命中 ${n('hitCount') || n('hits')}` : ''
  }
  if (key === 'contextPressure') {
    if (!('usedTokens' in evidence)) return ''
    return `已用 ${tokens(n('usedTokens'))} / ${tokens(n('contextWindow'))} · 余 ${tokens(n('room'))}`
  }
  if (key === 'modelStability') {
    if (!('turns' in evidence)) return ''
    return `${n('turns')} 轮 · 慢 ${n('slow')} · 超时 ${n('timeout')} · 空回 ${n('empty')}`
  }
  return ''
}

export default function HealthDegradationPanel() {
  const { data, error, mutate } = useSWR('her-degradation', HerApi.degradation, { refreshInterval: 180000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const assessment = data.assessment
  if (!assessment) return <EmptyLine>暂无退化自评数据。</EmptyLine>

  const level = levelMeta(assessment.level)
  const subscores = assessment.subscores || {}
  const gate = data.gate
  const actions = data.activeActions || []
  const degradedAt = finite(data.thresholds?.degraded, 0.45)
  const criticalAt = finite(data.thresholds?.critical, 0.72)
  const evaluated = assessment.evaluated || []
  const scheduled = data.scheduled || assessment.scheduled || {}

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
        <span className="text-xl font-semibold tabular-nums text-pi-text">{finite(assessment.score).toFixed(2)}</span>
        <Tag tone={level.tone}>{level.label}</Tag>
        <span className="text-xs text-pi-dim">
          总分；≥{degradedAt.toFixed(2)} 判下滑，≥{criticalAt.toFixed(2)} 判严重
        </span>
        <span className="ml-auto text-[11px] text-pi-dim2">
          {data.at ? `算于 ${fmtMsgTime(data.at)}` : ''}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {DEGRADATION_DIMS.map(key => {
          const sub = subscores[key]
          const score = finite(sub?.score)
          const scored = sub?.evaluated === true
          const tone = !scored ? 'neutral' : score >= criticalAt ? 'danger' : score >= degradedAt ? 'warn' : 'ok'
          // 未评估：条留空、读数是"—"，说明里带上后台给的原因（"没有反模式命中记录"这类），
          // 不写成 0%——0% 会被当成"这一维很好"。
          const hint = scored ? evidenceLine(key, sub?.evidence || {}) : `${sub?.note || ''}${sub?.note ? ' · ' : ''}未评估`
          return (
            <div key={key} className={scored ? '' : 'opacity-70'}>
              <Meter name={DEGRADATION_LABELS[key] || key} value={score} tone={tone} hint={hint} readout={scored ? percent(score) : '—'} />
            </div>
          )
        })}
      </div>

      <p className="text-[11px] text-pi-dim2">
        已评估 {evaluated.length} 维{assessment.unevaluated?.length ? ` · 未评估 ${assessment.unevaluated.length} 维（${assessment.unevaluated.join('、')}）` : ''}
        ；未评估的维度不计入总分，缺数据不等于健康。
      </p>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-pi-text">暂停闸</span>
          <Tag tone={gate?.on ? 'danger' : 'ok'}>{gate?.on ? '已暂停' : '未暂停'}</Tag>
          {gate?.on && gate.reason ? <span className="text-pi-dim break-words">{gate.reason}</span> : null}
          {gate?.on && gate.at ? <span className="text-pi-dim2">自 {fmtMsgTime(gate.at)}</span> : null}
        </div>
        {gate?.scopes && Object.values(gate.scopes).some(Boolean) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-pi-dim">
            分项停用：
            {Object.entries(gate.scopes).filter(([, on]) => on).map(([scope]) => (
              <Tag key={scope} tone="warn">{scope === 'proactive' ? '主动触达' : scope === 'media' ? '出图出片' : scope}</Tag>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-pi-text">挂着的动作</p>
        {actions.length ? (
          <ul className="space-y-1">
            {actions.map((item, index) => (
              <li key={`${item.action}-${index}`} className="text-xs text-pi-dim">
                {actionLabel(item.action)} · {item.scope === 'global' ? '全局' : item.scope || '全局'}
                {item.by ? ` · 由${item.by === 'user' ? '你' : item.by === 'degradation' || item.by === 'auto' ? '系统自动' : item.by}挂上` : ''}
                {item.since ? ` · 自 ${fmtMsgTime(item.since)}` : ''}
                {item.reason ? ` · ${item.reason}` : ''}
              </li>
            ))}
          </ul>
        ) : <EmptyLine>没有挂起的动作：当前没有闸在挡她。</EmptyLine>}
      </div>

      <p className="text-[11px] leading-relaxed text-pi-dim2">
        自动边界：低风险动作由系统按冷却时间自动执行；
        {(data.auto?.humanOnly || []).length ? `「${(data.auto?.humanOnly || []).map(actionLabel).join('」「')}」只能由人来按。` : '全局暂停只能由人来按。'}
        定时任务这边：{finite(scheduled.jobs)} 个作业 · 静默 {scheduled.silent?.length || 0} · 告警 {scheduled.alerts?.length || 0}。
      </p>
    </div>
  )
}
