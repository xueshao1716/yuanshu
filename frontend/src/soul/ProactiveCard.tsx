import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'

/**
 * 主动管理（2026-10-27）
 *
 * 抄 Manus Cue 的那点用户价值：**不用你开口就在盯**。
 * 这里放三样东西：我在盯什么、我追过什么、以及"停止盯这件事"。
 */
type Watch = { id: string; title: string; keywords: string[]; status: string; createdAt: number }
type Loop = { key: string; kind: string; title: string; status: string; attempts: number; lastActionAt: number; lastAction: string }
type Payload = { ok: boolean; watches: Watch[]; loops: Loop[]; actions: { at: number; action: string; title: string }[] }

const Api = {
  list: () => api<Payload>('/api/proactive'),
  watch: (title: string) => api<{ ok: boolean; error?: string }>('/api/proactive/watch', {
    method: 'POST', body: JSON.stringify({ title }),
  }),
  stop: (id: string) => api<{ ok: boolean }>('/api/proactive/stop', { method: 'POST', body: JSON.stringify({ id }) }),
}

const pill: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', minHeight: 26, padding: '0 10px',
  borderRadius: 999, fontSize: 12, border: '1px solid var(--pi-border-soft, #bfc4cb)',
  background: 'var(--pi-bg3, #eef0f3)', color: 'var(--pi-text, #222)', cursor: 'pointer',
}

export default function ProactiveCard() {
  const { data, mutate, isLoading } = useSWR('proactive', () => Api.list(), { refreshInterval: 60000 })
  const [title, setTitle] = useState('')
  const [msg, setMsg] = useState('')

  const add = async () => {
    const t = title.trim()
    if (!t) return
    const r = await Api.watch(t).catch((e) => ({ ok: false, error: String(e?.message || e) }))
    setMsg(r.ok ? `开始盯「${t}」` : `没记上：${r.error || '未知原因'}`)
    if (r.ok) setTitle('')
    await mutate()
  }

  const stop = async (id: string) => {
    await Api.stop(id).catch(() => null)
    await mutate()
  }

  const watches = (data?.watches || []).filter((w) => w.status === 'watching')
  const open = (data?.loops || []).filter((l) => l.status !== 'done')

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        <strong>{watches.length}</strong> 件在盯，<strong>{open.length}</strong> 件在跟进。
        追的节奏是有节制的：同一件事 6 小时内最多催一次，最多催两次，然后升级一次——**再之后就不吵你了**。
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
          placeholder="要盯的事，比如「资料库权限改造」"
          style={{
            flex: 1, minHeight: 32, padding: '0 10px', fontSize: 12.5,
            borderRadius: 8, border: '1px solid var(--pi-border-soft, #bfc4cb)',
            background: 'var(--pi-panel, #fff)', color: 'var(--pi-text, #222)',
          }}
        />
        <button type="button" style={pill} onClick={add}>盯着</button>
      </div>
      {msg ? <p className="tone-sources-dim">{msg}</p> : null}

      {watches.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {watches.map((w) => (
            <span key={w.id} style={{ ...pill, cursor: 'default' }}>
              {w.title}
              <button
                type="button"
                onClick={() => stop(w.id)}
                title="不再盯"
                style={{ marginLeft: 6, border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--pi-dim)' }}
              >×</button>
            </span>
          ))}
        </div>
      ) : null}

      {open.length ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
          {open.slice(0, 6).map((l) => (
            <li key={l.key} style={{ fontSize: 12.5, color: 'var(--pi-dim2)', marginBottom: 4 }}>
              {l.title}
              <span style={{ marginLeft: 6, color: 'var(--pi-dim)' }}>
                （{l.status === 'escalated' ? '需要你拍板' : '已提醒'} · 第 {l.attempts} 次）
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tone-sources-dim">现在没有需要追的事。</p>
      )}
    </div>
  )
}
