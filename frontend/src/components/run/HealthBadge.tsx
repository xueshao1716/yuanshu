import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react'

export default function HealthBadge({ status, label }: { status: 'idle' | 'busy' | 'degraded'; label?: string }) {
  const meta = status === 'busy'
    ? { text: label || '运行中', Icon: LoaderCircle, cls: 'text-pi-accent bg-pi-accent-soft border-pi-accent/20' }
    : status === 'degraded'
      ? { text: label || '需关注', Icon: AlertTriangle, cls: 'text-pi-warning bg-pi-warning/10 border-pi-warning/20' }
      : { text: label || '状态正常', Icon: CheckCircle2, cls: 'text-pi-success bg-pi-success/10 border-pi-success/20' }
  return <span className={`inline-flex items-center gap-1.5 rounded-pi-pill border px-2 py-1 text-[11px] ${meta.cls}`}><meta.Icon className={`h-3.5 w-3.5 ${status === 'busy' ? 'animate-spin' : ''}`} />{meta.text}</span>
}
