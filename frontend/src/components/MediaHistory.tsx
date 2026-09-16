import { History } from 'lucide-react'
import useSWR from 'swr'
import { WsApi, withFileToken } from '../api'
import type { Artifact } from '../types'

export default function MediaHistory({ kind, onPick }: {
  kind: 'image' | 'video'
  onPick: (item: Artifact) => void
}) {
  const { data } = useSWR('artifacts', () => WsApi.artifacts(), { revalidateOnFocus: true, dedupingInterval: 8000 })
  const type = kind === 'image' ? '图片' : '视频'
  const items = (data?.artifacts || []).filter(a => a.type === type).slice(0, 24)
  if (!items.length) return null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[11px] text-pi-dim2">
        <History className="w-3.5 h-3.5" />
        <span>往期</span>
        {/* 70% 的 dim2 在浅底上只有 2.8（真机量的），11px 小字不该再打折 */}
        <span className="text-pi-dim2">点开回看，有提示词会填回</span>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {items.map(a => (
          <button key={a.path} type="button" onClick={() => onPick(a)}
            className="flex-shrink-0 w-20 min-h-11 rounded-pi-md overflow-hidden border border-pi-border-soft hover:border-pi-accent/40 bg-black/30"
            title={a.prompt || a.name}>
            {kind === 'image'
              ? <img src={withFileToken(a.url)} alt="" className="w-20 h-20 object-cover" />
              : <video src={withFileToken(a.url)} muted playsInline preload="metadata" className="w-20 h-20 object-cover bg-black" />}
          </button>
        ))}
      </div>
    </div>
  )
}
