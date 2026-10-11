import useSWR from 'swr'
import { BellRing } from 'lucide-react'
import { ConfirmApi } from '../api'

// 「该你出手了」全局直白弹条（2026-10-11 伙伴设计的定音）：
// 不玩收纳、不玩担心打扰——有越线确认就把它拍在所有页面脸上，一处点击直达处理区。
// 数据源与授权中心"等我确认"同一个聚合接口（agent-pending），SWR 同键去重，不重复请求。
const summaries = (items: { kind: string }[]) => {
  const byKind = new Map<string, number>()
  for (const it of items) byKind.set(it.kind, (byKind.get(it.kind) || 0) + 1)
  return [...byKind.entries()].map(([k, n]) => (n > 1 ? `${k}${n} 件` : k)).join(' · ')
}

export default function PendingCallout() {
  const state = useSWR('agent-pending', () => ConfirmApi.pending(), { refreshInterval: 6000 })
  const items = state.data?.items || []
  if (!items.length) return null
  const summary = summaries(items)
  return (
    <a href="#/grants" role="status" aria-live="assertive"
      className="fixed z-40 flex items-center gap-2 max-w-[92vw] rounded-pi-md px-3.5 py-2.5 text-sm font-medium shadow-lg border border-pi-warning/40 bg-pi-warning/10 text-pi-text hover:bg-pi-warning/20 transition-colors
        max-sm:bottom-[calc(env(safe-area-inset-bottom,0px)+76px)] max-sm:left-1/2 max-sm:-translate-x-1/2
        sm:top-16 sm:right-4"
      style={{ pointerEvents: 'auto' }}>
      <BellRing className="w-4 h-4 shrink-0 text-pi-warning" aria-hidden="true" />
      <span className="whitespace-nowrap">该你出手了</span>
      <span className="text-pi-dim2 whitespace-nowrap truncate">{items.length} 件待确认{summary ? ` · ${summary}` : ''}</span>
      <span className="pii-strong whitespace-nowrap text-pi-warning">处理 ›</span>
    </a>
  )
}
