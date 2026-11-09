// 机制新鲜度（/api/vitality）——只读
// 回答的问题只有一个：这些后台机制**还在产出吗**。
// fresh 绿 / stale 黄 / never 红 / unknown 灰 是这套色点的唯一来源，其他面板不许自造颜色。
// 刻意不显示：引擎模块路径（code）、"下一步看哪"（look）——那是给接手的人/模型看的，
// 给用户看的是"哪一块停了、停了多久、卡在哪件事上"。
import useSWR from 'swr'
import { FRESH_META, HerApi, finite, freshMeta, type FreshnessState } from '../../lib/her-api'
import { Dot, EmptyLine, FailureLine, LoadingLine, Tag } from '../readout'
import { fmtMsgTime } from '../../lib/fmt-time'

const STATES: FreshnessState[] = ['fresh', 'stale', 'never', 'unknown']

export default function HealthVitalityPanel() {
  const { data, error, mutate } = useSWR('her-vitality', HerApi.vitality, { refreshInterval: 300000, revalidateOnFocus: true })
  if (error) return <FailureLine error={error} onRetry={() => void mutate()} />
  if (!data) return <LoadingLine />

  const counts = data.counts || {}
  const total = finite(counts.total)
  if (!total) return <EmptyLine>暂无体检数据：后台还没跑过一次机制体检。</EmptyLine>

  const issues = data.issues || []
  const unknown = data.unknown || []
  const flags = data.flags || []
  const lastTick = data.lastTick

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {STATES.map(state => (
          <span key={state} className="inline-flex items-center gap-1.5 text-xs text-pi-dim">
            <Dot tone={FRESH_META[state].tone} />
            {FRESH_META[state].label}
            <strong className="font-mono tabular-nums text-pi-text">{finite((counts as Record<string, unknown>)[state])}</strong>
          </span>
        ))}
        <span className="text-xs text-pi-dim2">共 {total} 项机制</span>
        <span className="ml-auto">
          <Tag tone={data.healthy ? 'ok' : 'warn'}>{data.healthy ? '都在产出' : `${finite(data.needsAttention)} 项要处理`}</Tag>
        </span>
      </div>

      {data.line && <p className="text-[11px] leading-relaxed text-pi-dim2 break-words">{data.line}</p>}

      {issues.length > 0 && (
        <ul className="space-y-2">
          {issues.map(item => {
            const meta = freshMeta(item.state)
            return (
              <li key={item.id || item.name} className="flex items-start gap-2 text-xs">
                <span className="mt-1"><Dot tone={meta.tone} label={meta.label} /></span>
                <div className="min-w-0">
                  <span className="text-pi-text">{item.name || '未命名机制'}</span>
                  <span className="ml-1.5 text-pi-dim2">{item.label || meta.label}</span>
                  {item.why && <p className="mt-0.5 text-pi-dim break-words">{item.why}</p>}
                  {item.lastAt ? <p className="text-pi-dim2">最近一次产出：{fmtMsgTime(item.lastAt)}</p> : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {unknown.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-pi-dim2">无证据（不能判好坏，别当成正常）</p>
          <ul className="space-y-1">
            {unknown.map(item => (
              <li key={item.id || item.name} className="flex items-start gap-2 text-xs text-pi-dim">
                <span className="mt-1"><Dot tone="neutral" label="无证据" /></span>
                <span className="min-w-0">
                  {item.name || '未命名机制'}
                  {item.why ? <span className="ml-1.5 text-pi-dim2 break-words">{item.why}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {flags.length > 0 && (
        <ul className="space-y-1">
          {flags.map(item => (
            <li key={item.id || item.name} className="text-xs text-pi-yellow">
              提词：{item.name}{item.note ? ` — ${item.note}` : ''}
            </li>
          ))}
        </ul>
      )}

      {lastTick?.at ? (
        <p className="text-[11px] text-pi-dim2">
          这套体检由后台每 6 小时落一次盘；最近一次 {fmtMsgTime(lastTick.at)}
          {finite(lastTick.needsAttention) > 0 ? `（当时 ${finite(lastTick.needsAttention)} 项要处理）` : '（当时全部正常）'}
        </p>
      ) : (
        <p className="text-[11px] text-pi-dim2">后台还没落过盘：这是实时算出来的结果，循环可能刚起。</p>
      )}
    </div>
  )
}
