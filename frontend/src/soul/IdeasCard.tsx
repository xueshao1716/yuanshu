import useSWR from 'swr'
import { useState } from 'react'
import { SystemApi } from '../api'

/**
 * 今日建议（2026-10-25，对标 Muse 的 Idea curation）。
 *
 * 不是随机推荐：种子来自承诺、牵挂、久未推进的定时任务、以及她随口说过的「改天再说」。
 * 每条都有分数和理由，你可以采纳（变成目标 + 自动拆成几步）或直接说不要。
 */
export default function IdeasCard() {
  const { data, mutate, isLoading } = useSWR('soul-ideas', () => SystemApi.ideas(), { refreshInterval: 60000 })
  const { data: goals, mutate: mutateGoals } = useSWR('soul-goals', () => SystemApi.ideaGoals())
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const items = data?.items || []
  const goalItems = (goals?.items || []).filter((g: any) => (g.steps || []).some((s: any) => !s.done))

  const accept = async (id: string) => {
    setBusy(id); setMsg('')
    try {
      const out = await SystemApi.acceptIdea(id)
      if ((out as any)?.ok === false) setMsg((out as any).error || '采纳失败')
      else setMsg((out as any)?.steps?.length ? `已采纳，拆成 ${(out as any).steps.length} 步` : '已采纳')
      await Promise.all([mutate(), mutateGoals()])
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) } finally { setBusy('') }
  }

  const dismiss = async (id: string) => {
    setBusy(id); setMsg('')
    try { await SystemApi.dismissIdea(id); await mutate() }
    catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) } finally { setBusy('') }
  }

  const tick = async (goalId: string, stepId: number) => {
    setBusy(`${goalId}:${stepId}`); setMsg('')
    try { await SystemApi.completeIdeaStep(goalId, stepId); await mutateGoals() }
    catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) } finally { setBusy('') }
  }

  if (!isLoading && !items.length && !goalItems.length) {
    return <p className="tone-sources-dim">今天没有候选目标。建议来自承诺、牵挂、久未推进的定时任务和你说过「改天再说」的事——有就出现，没有就不占地方。</p>
  }

  return (
    <div className="tone-sources">
      {items.length > 0 && (
        <>
          <p className="tone-sources-line">
            这些是我从<strong>你答应过的事、提过没落地的、久没推进的任务</strong>里挑出来的，不是随机推荐。
            采纳了会变成目标并自动拆成几步。
          </p>
          {items.map((it: any) => (
            <article key={it.id} className="soul-record">
              <h4>{it.text}</h4>
              <p className="tone-sources-dim">{it.reason} · 分 {it.score}</p>
              <div className="persona-style-row">
                <button className="persona-style-opt" disabled={busy === it.id} onClick={() => accept(it.id)}>采纳</button>
                <button className="persona-style-opt" disabled={busy === it.id} onClick={() => dismiss(it.id)}>不要</button>
              </div>
            </article>
          ))}
        </>
      )}

      {goalItems.length > 0 && (
        <>
          <p className="tone-sources-line" style={{ marginTop: 10 }}><strong>已采纳的目标</strong>（做完一步勾一步，她才不会一直“进行中”）</p>
          {goalItems.map((g: any) => (
            <article key={g.id} className="soul-record">
              <h4>{g.text}</h4>
              <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                {(g.steps || []).map((s: any) => (
                  <li key={s.id} className="tone-sources-dim">
                    <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!s.done}
                        disabled={!!s.done || busy === `${g.id}:${s.id}`}
                        onChange={() => tick(g.id, s.id)}
                        style={{ marginTop: 3 }}
                      />
                      <span style={{ textDecoration: s.done ? 'line-through' : 'none' }}>{s.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </>
      )}

      {msg ? <p className="soul-tone-err">{msg}</p> : null}
    </div>
  )
}
