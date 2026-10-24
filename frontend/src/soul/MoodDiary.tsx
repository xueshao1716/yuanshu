import { useState } from 'react'
import useSWR from 'swr'
import { SoulApi, type MoodDiary } from './api'
import { NotebookPen, ChevronDown } from 'lucide-react'

/**
 * 心情日记（2026-10-24）
 *
 * 数据全部来自真实的情绪记录（情绪感受.jsonl / 情绪潮汐.jsonl），不调模型、不编造。
 * 每天 23:30 后由服务端自动写一篇；这里只负责展示最近几篇。
 */
export default function MoodDiaryList() {
  const { data, error } = useSWR('mood-diaries', () => SoulApi.moodDiaries(7), { refreshInterval: 300_000, revalidateOnFocus: false })
  const [open, setOpen] = useState<string | null>(null)
  const items: MoodDiary[] = data?.items || []

  return (
    <div className="mood-diary">
      {error ? (
        <p className="md-hint">心情日记读取失败，可稍后刷新。</p>
      ) : !items.length ? (
        <p className="md-hint">还没有日记。今晚 23:30 之后会自动写下第一篇（数据来自当天的情绪记录）。</p>
      ) : (
        <ul className="md-list">
          {items.map((d) => {
            const expanded = open === d.date
            return (
              <li key={d.date}>
                <button type="button" className={`md-row${expanded ? ' is-open' : ''}`} onClick={() => setOpen(expanded ? null : d.date)}>
                  <NotebookPen size={14} strokeWidth={1.8} aria-hidden="true" />
                  <span className="md-date">{d.date}</span>
                  <span className="md-summary">{d.summary || '（今日无记录）'}</span>
                  {d.weather && <span className="md-weather">{d.weather}</span>}
                  <ChevronDown size={14} className={`md-chevron${expanded ? ' is-open' : ''}`} aria-hidden="true" />
                </button>
                {expanded && <DiaryText date={d.date} />}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function DiaryText({ date }: { date: string }) {
  const { data, error } = useSWR(['mood-diary', date], () => SoulApi.moodDiary(date), { revalidateOnFocus: false })
  if (error) return <p className="md-hint">这篇读取失败。</p>
  if (!data) return <p className="md-hint">读取中…</p>
  return <pre className="md-text">{data.text}</pre>
}
