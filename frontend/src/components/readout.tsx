// 只读读数构件（2026-11-10）
// 关系 / 成长 / 账本 / 体检 / 退化 / 审计这些面板要的东西是同一类：
// 一个色点、一条进度、一个标签、一句说明、一个空态、一个错误态。
// 机制新鲜度要求"fresh 绿 / stale 黄 / never 红 / unknown 灰"——色点语义只在这里定义一次，
// 不让每个面板各写一套颜色，否则同一个 stale 在两个页面可能是两种黄。
import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info'

const DOT_CLS: Record<Tone, string> = {
  neutral: 'bg-pi-dim2',
  ok: 'bg-pi-green',
  warn: 'bg-pi-yellow',
  danger: 'bg-pi-red',
  info: 'bg-pi-accent',
}

const TAG_CLS: Record<Tone, string> = {
  neutral: 'border-pi-border bg-pi-bg2 text-pi-dim',
  ok: 'border-pi-green/35 bg-pi-green/10 text-pi-green',
  warn: 'border-pi-yellow/35 bg-pi-yellow/10 text-pi-yellow',
  danger: 'border-pi-red/35 bg-pi-red/10 text-pi-red',
  info: 'border-pi-accent/35 bg-pi-accent/10 text-pi-accent',
}

/** 状态色点。给了 label 就当作图像读给屏幕阅读器；没给就是纯装饰。 */
export function Dot({ tone = 'neutral', label }: { tone?: Tone; label?: string }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLS[tone]}`}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  )
}

/** 小标签：分类、等级、严重度。 */
export function Tag({ tone = 'neutral', title, children }: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-pi-pill border px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap ${TAG_CLS[tone]}`}>
      {children}
    </span>
  )
}

/** 0..1 的横条（div 实现，不引图表库）。 */
export function Bar({ value, tone = 'info', label }: { value: number; tone?: Tone; label?: string }) {
  const ratio = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
  const pct = Math.round(ratio * 100)
  return (
    <div
      className="h-1.5 rounded-full bg-pi-bg3 overflow-hidden"
      role="img"
      aria-label={label || `${pct}%`}
      title={label || `${pct}%`}
    >
      <div className={`h-full rounded-full ${DOT_CLS[tone]}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

const percent2 = (v: number) => `${Math.round((Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0) * 100)}%`

/** 一行读数：名称 + 横条 + 数值（readout 可换成"0.34"这种原始值）。 */
export function Meter({
  name, value, tone = 'info', hint, readout,
}: { name: ReactNode; value: number; tone?: Tone; hint?: ReactNode; readout?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-pi-text">{name}</span>
        {hint && <span className="text-pi-dim2 min-w-0 truncate">{hint}</span>}
        <span className="ml-auto font-mono tabular-nums text-pi-dim">{readout || percent2(value)}</span>
      </div>
      <Bar value={value} tone={tone} label={`${typeof name === 'string' ? name : '进度'} ${percent2(value)}`} />
    </div>
  )
}

/** 空态：接口通了、但没有内容。 */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="py-1.5 text-xs text-pi-dim2">{children}</p>
}

/** 读取中：只占一行，不闪骨架。 */
export function LoadingLine({ children }: { children?: ReactNode }) {
  return <p role="status" className="py-1.5 text-xs text-pi-dim2">{children || '正在读取…'}</p>
}

/**
 * 错误态：接口 404/500 或断网时**必须**走到这里，不能白屏。
 * 统一文案「暂无数据」+ 原始错误（截断）+ 重试；重试回调可选。
 */
export function FailureLine({ error, onRetry, label = '暂无数据' }: { error: unknown; onRetry?: () => void; label?: string }) {
  const message = (error instanceof Error ? error.message : String(error || '')).slice(0, 160)
  return (
    <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5 text-xs text-pi-dim2">
      <span>{label}</span>
      {message && <span className="break-all">（{message}）</span>}
      {onRetry && (
        <button type="button" className="btn-tool !h-6 !min-h-6 !px-2 text-[11px]" onClick={onRetry}>重试</button>
      )}
    </div>
  )
}

/** 面板里的小标题（比 SectionHeader 弱一级，用于同一节里的分组）。 */
export function SubHead({ children, hint, right }: { children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h3 className="text-[13px] font-semibold text-pi-text">{children}</h3>
      {hint && <span className="text-[11px] text-pi-dim2">{hint}</span>}
      {right && <div className="ml-auto flex items-center gap-1.5">{right}</div>}
    </div>
  )
}
