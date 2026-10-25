import useSWR from 'swr'
import { useState } from 'react'
import { SystemApi } from '../api'

/**
 * 反馈收件箱（2026-10-26）。
 *
 * 之前它藏在右下角一个小面板里，43 条全是自动上报的崩溃回执，用户根本不知道那是啥。
 * 这里做成能看的卡片：按签名分组、显示条数与最近时间、可以直接标 done / wontfix。
 */
type Item = { id: string; at: number; title: string; detail?: string; status: string; kind?: string; signature?: string }
type Group = { signature: string; kind: string; count: number; lastAt: number; status: string; title: string }

export default function FeedbackCard() {
  const { data, mutate, isLoading } = useSWR('soul-feedback', () => SystemApi.feedback(), { refreshInterval: 60000 })
  const { data: sum, mutate: mutateSum } = useSWR('soul-feedback-summary', () => SystemApi.feedbackSummary(), { refreshInterval: 60000 })
  const [busy, setBusy] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const items: Item[] = (data as any)?.items || []
  const groups: Group[] = (sum as any)?.groups || []
  const openCount = items.filter((i) => i.status === 'open').length

  const mark = async (id: string, status: 'done' | 'wontfix') => {
    setBusy(id)
    try { await SystemApi.feedbackMark(id, status); await Promise.all([mutate(), mutateSum()]) }
    catch { /* 失败就保持原样，刷新会看到真实状态 */ }
    finally { setBusy('') }
  }

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>
  if (!items.length) return <p className="tone-sources-dim">收件箱是空的。</p>

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        共 <strong>{items.length}</strong> 条，<strong>{openCount}</strong> 条待处理。
        绝大多数是<strong>自动上报</strong>（进程异常退出时自动发，带版本和运行时长）；你可以直接标完成或忽略。
      </p>

      {groups.map((g) => (
        <article key={g.signature} className="soul-record">
          <h4>{String(g.title || '').replace('[自动上报] ', '')}</h4>
          <p className="tone-sources-dim">
            ×{g.count} · 最近 {new Date(g.lastAt).toLocaleString('zh-CN', { hour12: false })} · {g.status}
          </p>
          <div className="persona-style-row">
            <button className="persona-style-opt" onClick={() => setOpen(open === g.signature ? null : g.signature)}>
              {open === g.signature ? '收起' : '看条目'}
            </button>
          </div>

          {open === g.signature && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
              {items.filter((i) => i.signature === g.signature).slice(0, 8).map((i) => (
                <li key={i.id} className="tone-sources-dim" style={{ marginBottom: 6 }}>
                  {new Date(i.at).toLocaleString('zh-CN', { hour12: false })} · {i.status}
                  {i.status === 'open' && (
                    <span style={{ marginLeft: 8 }}>
                      <button className="persona-style-opt" disabled={busy === i.id} onClick={() => mark(i.id, 'done')}>完成</button>
                      <button className="persona-style-opt" disabled={busy === i.id} onClick={() => mark(i.id, 'wontfix')} style={{ marginLeft: 4 }}>忽略</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  )
}
