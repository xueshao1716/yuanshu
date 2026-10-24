import useSWR from 'swr'
import { SoulApi } from './api'
import { Scale } from 'lucide-react'

type TasteItem = { at: string; topic: string; chose: string; rejected: string[]; why: string; tags: string[] }

/** 品味库（2026-10-24）：跨会话的判断轨迹——选了什么、否了什么、为什么 */
export default function TasteList() {
  const { data, error } = useSWR('taste-recent', () => SoulApi.taste(20), { refreshInterval: 300_000, revalidateOnFocus: false })
  const items: TasteItem[] = data?.items || []
  if (error) return <p className="md-hint">品味库读取失败，稍后刷新。</p>
  if (!items.length) return <p className="md-hint">还没有记录。等她做出取舍时（选字体、定方案、否掉某个方向）会说一句「记进品味库」。</p>
  return (
    <ul className="md-list">
      {items.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <div className="taste-row">
            <Scale size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="taste-topic">{e.topic}</span>
            <span className="taste-chose">{e.chose}</span>
            {e.rejected?.length > 0 && <span className="taste-rejected">否：{e.rejected.join('、')}</span>}
            {e.why && <span className="taste-why">{e.why}</span>}
            <span className="taste-at">{e.at.slice(5, 10)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}
