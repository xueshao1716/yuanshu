import { useState } from 'react'
import useSWR from 'swr'
import { BriefApi, type MorningBrief } from '../api'
import { RefreshCw, X, Sun } from 'lucide-react'

/**
 * 今日晨报（2026-10-22）
 *
 * 灵感来自 Claude Duet 的晨间简报：不等用户问，先把「昨夜做了什么 / 今天该做什么 /
 * 哪里出过问题」摆出来。内容全部来自已落盘事实，不调模型。
 */
export default function BriefCard() {
  const [hidden, setHidden] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const { data, mutate, isValidating } = useSWR<MorningBrief>('morning-brief', () => BriefApi.today(), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  })

  if (hidden) return null
  if (!data) return null
  // 没有值得说的内容就不占位置：只有"一切正常"且没有承诺/慢请求时收起
  const notable = (data.lines?.length || 0) > 0 && data.headline !== '一切正常'
  if (!notable && !data.promises?.pending) return null

  const refresh = async () => {
    setRefreshing(true)
    try {
      const fresh = await BriefApi.today(true)
      await mutate(fresh, { revalidate: false })
    } catch {}
    finally { setRefreshing(false) }
  }

  return (
    <section className="brief-card" aria-label="今日晨报">
      <div className="brief-head">
        <span className="brief-title"><Sun className="h-4 w-4" strokeWidth={1.8} />今日晨报</span>
        <span className={`brief-badge ${data.headline === '一切正常' ? 'ok' : 'warn'}`}>{data.headline}</span>
        <span className="brief-date">{data.date}</span>
        <div className="brief-actions">
          <button type="button" onClick={refresh} title="重新生成" disabled={refreshing || isValidating}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.8} />
          </button>
          <button type="button" onClick={() => setHidden(true)} title="今天不再显示">
            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      <ul className="brief-lines">
        {(data.lines || []).map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </section>
  )
}
