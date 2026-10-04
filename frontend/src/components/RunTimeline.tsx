import { Check, Circle, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { RunPhase } from '../api'

const STEPS: { key: RunPhase; label: string }[] = [
  { key: 'thinking', label: '判断' },
  { key: 'executing', label: '执行' },
  { key: 'remembering', label: '记忆' },
  { key: 'delivering', label: '交付' },
]
const order = ['queued', ...STEPS.map(s => s.key), 'completed']

export default function RunTimeline({ phase, compact = false }: { phase: RunPhase; compact?: boolean }) {
  const failed = ['failed', 'stopped', 'interrupted'].includes(phase)
  const statusNotice = phase === 'stopping' ? '停止中' : phase === 'unknown' ? '状态未知' : ''
  const current = order.indexOf(phase)
  return <div aria-label={`运行阶段：${phase}`} className={`flex items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
    {STEPS.map((step, index) => {
      const done = !failed && current > order.indexOf(step.key)
      const active = !failed && phase === step.key
      const Icon = failed && active ? TriangleAlert : active ? LoaderCircle : done ? Check : Circle
      return <div key={step.key} className="flex items-center gap-1 text-[10px] text-pi-dim2">
        <Icon className={`h-3.5 w-3.5 ${failed && active ? 'text-pi-error' : active ? 'text-pi-accent animate-spin' : done ? 'text-pi-success' : ''}`} />
        {!compact && <span className={active ? 'text-pi-text font-medium' : ''}>{step.label}</span>}
        {index < STEPS.length - 1 && <span className="mx-0.5 text-pi-border">→</span>}
      </div>
    })}
    {statusNotice && <span className="ml-1 text-[10px] font-medium text-pi-warning">{statusNotice}</span>}
  </div>
}
