import { useCallback, useEffect, useRef, useState } from 'react'
import { KeysApi } from '../../api'
import type { MediaObservationSnapshot } from '../../api'

const kinds = { image: '绘图', video: '视频', tts: '朗读' }
const phases: Record<string, string> = { generate: '生成', create: '提交', poll: '查询', reply: '回复朗读', reply_stream: '流式朗读' }

export default function MediaObservations() {
  const [data, setData] = useState<MediaObservationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const active = useRef(false), lock = useRef(false)
  const load = useCallback(async () => {
    if (lock.current) return
    lock.current = true; setLoading(true); setError(false)
    try {
      const result = await KeysApi.mediaObservations()
      if (active.current) setData(result)
    } catch { if (active.current) setError(true) }
    finally { lock.current = false; if (active.current) setLoading(false) }
  }, [])
  useEffect(() => { active.current = true; void load(); return () => { active.current = false } }, [load])
  const items = data?.items || []
  return <section className="mt-6 border-t border-pi-border-soft pt-4" aria-label="近期实际调用失败">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold text-pi-text">近期实际调用失败</h3>
      <button className="btn-tool touch-hit min-h-11 min-w-11 after:inset-0 text-sm" disabled={loading} onClick={() => void load()}>
        {loading ? '读取中…' : error ? '重试读取' : '刷新记录'}
      </button>
    </div>
    <p className="text-sm text-pi-dim mt-1 max-w-prose">仅记录绘图、视频与朗读的实际失败，不含实时通话。刷新只读记录，不会试调用模型或产生探测费用。</p>
    <p className="text-sm text-pi-dim mt-2">本次服务启动后，最多保留近 24 小时的 80 条；服务重启会清空。没有失败记录不代表通道健康。</p>
    {error && <p role="alert" className="text-sm text-pi-danger mt-3">记录读取失败，请重试读取。{data ? '下方保留上次读取的记录，可能已过时。' : ''}</p>}
    {loading && !data && <p role="status" className="text-sm text-pi-dim py-3">正在读取实际调用记录…</p>}
    {!loading && !error && !items.length && <p role="status" className="text-sm text-pi-dim py-3">当前保留范围内暂无失败记录。</p>}
    {!!items.length && <ul className="divide-y divide-pi-border-soft mt-3">
      {(expanded ? items : items.slice(0, 5)).map(item => <li key={item.id} className="py-3 text-sm">
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
          <span className="font-medium text-pi-text">{kinds[item.kind]} · {phases[item.phase] || '调用'}{item.status ? ` · HTTP ${item.status}` : ''}</span>
          <time className="text-pi-dim tabular-nums" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
        </div>
        <p className="text-pi-text break-all mt-1">{item.provider} / {item.model}</p>
        <p className="text-pi-dim mt-1 break-words">{item.message}</p>
      </li>)}
    </ul>}
    {items.length > 5 && <button className="btn-tool touch-hit min-h-11 min-w-11 after:inset-0 text-sm mt-2" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起记录' : `查看其余 ${items.length - 5} 条`}
    </button>}
  </section>
}
