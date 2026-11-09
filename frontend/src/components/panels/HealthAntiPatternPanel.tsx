// 反模式台账（/api/anti-patterns）——只读
// 这是"她踩过的坑"的清单：怎么认（症状）、怎么改（remedy）。退化自评里的"可信"维度
// 就来自这里的命中记录，所以放在健康页而不是人格页。
// 刻意不显示：台账文件路径、命中日志路径、触发规则（trigger.detect）、关键词与来源出处——
// 那是维护这份台账的人要看的；用户要的是"哪类坑、下次怎么绕开"。
import useSWR from 'swr'
import { HerApi, SEVERITY_META, finite } from '../../lib/her-api'
import { EmptyLine, FailureLine, LoadingLine, Tag } from '../readout'

export default function HealthAntiPatternPanel() {
  const { data, error, mutate } = useSWR('her-anti-patterns', HerApi.antiPatterns, { refreshInterval: 300000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const stats = data.stats
  const total = finite(stats?.total ?? data.total)
  if (!total) return <EmptyLine>台账还是空的：还没有被记下来的反模式。</EmptyLine>

  const patterns = data.patterns || []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-pi-dim">
        <span>已登记 <strong className="font-mono tabular-nums text-pi-text">{total}</strong> 条</span>
        <span className="inline-flex items-center gap-1.5"><Tag tone="danger">高</Tag>{finite(stats?.high)}</span>
        <span className="inline-flex items-center gap-1.5"><Tag tone="warn">中</Tag>{finite(stats?.medium)}</span>
        <span className="inline-flex items-center gap-1.5"><Tag tone="neutral">低</Tag>{finite(stats?.low)}</span>
        <span className="ml-auto text-pi-dim2">连续命中会升一档，high 封顶</span>
      </div>

      <ul className="space-y-1.5">
        {patterns.map(pattern => {
          const meta = SEVERITY_META[String(pattern.severity)] || SEVERITY_META.low
          return (
            <li key={pattern.id || pattern.title}>
              <details className="text-xs">
                <summary className="flex cursor-pointer items-center gap-2 hover:text-pi-text transition-colors">
                  <Tag tone={meta.tone}>{meta.label}</Tag>
                  <span className="text-xs text-pi-text">{pattern.title || pattern.id}</span>
                </summary>
                {pattern.symptom && <p className="mt-1 ml-1 text-xs text-pi-dim">症状：{pattern.symptom}</p>}
                {pattern.remedy && <p className="mt-1 ml-1 text-xs text-pi-text">该：{pattern.remedy}</p>}
                {pattern.discoveredAt && <p className="mt-1 ml-1 text-[11px] text-pi-dim2">记于 {pattern.discoveredAt}</p>}
              </details>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
