import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'

/**
 * 自动补丁面板（2026-10-26）
 *
 * 用户原话：「怎么给我整了一堆 bash 啊，不会用啊，你能不能整成面板」
 * 所以这里只做三件事：看改动、合并、丢弃。不需要敲任何命令。
 */
type Patch = {
  branch: string
  commit: string
  subject: string
  at: number | null
  stat: string
  files: string[]
}

const PatchApi = {
  list: () => api<{ ok: boolean; error?: string; items: Patch[] }>('/api/autopatch/patches'),
  diff: (branch: string) => api<{ ok: boolean; diff?: string; error?: string; truncated?: boolean }>(
    `/api/autopatch/diff?branch=${encodeURIComponent(branch)}`),
  merge: (branch: string) => api<{ ok: boolean; error?: string }>('/api/autopatch/merge', { method: 'POST', body: { branch } }),
  discard: (branch: string) => api<{ ok: boolean; error?: string }>('/api/autopatch/discard', { method: 'POST', body: { branch } }),
}

export default function AutoPatchCard() {
  const { data, mutate, isLoading } = useSWR('autopatch-patches', () => PatchApi.list(), { refreshInterval: 60000 })
  const [openDiff, setOpenDiff] = useState<string | null>(null)
  const [diff, setDiff] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const items = data?.items || []

  const showDiff = async (branch: string) => {
    if (openDiff === branch) { setOpenDiff(null); return }
    setBusy(branch); setMsg('')
    try {
      const r = await PatchApi.diff(branch)
      if (!r.ok) { setMsg(r.error || '读取 diff 失败'); return }
      setDiff(r.diff || '')
      setOpenDiff(branch)
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  const merge = async (branch: string) => {
    if (!window.confirm(`把 ${branch} 合进主线？\n合并后这些改动就生效了。`)) return
    setBusy(branch); setMsg('')
    try {
      const r = await PatchApi.merge(branch)
      setMsg(r.ok ? '已合并到主线' : (r.error || '合并失败'))
      await mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  const discard = async (branch: string) => {
    if (!window.confirm(`丢弃 ${branch}？\n改动会被删除，主线不受影响。`)) return
    setBusy(branch); setMsg('')
    try {
      const r = await PatchApi.discard(branch)
      setMsg(r.ok ? '已丢弃' : (r.error || '丢弃失败'))
      await mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>
  if (data && data.ok === false) return <p className="tone-sources-dim">{data.error || '读不到补丁分支'}</p>
  if (!items.length) return <p className="tone-sources-dim">现在没有待审的自动补丁。有提案通过门禁后，会出现在这里。</p>

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        <strong>{items.length}</strong> 个自动补丁等人审。它们只在独立分支上，<strong>没合进主线之前不影响任何东西</strong>。
      </p>

      {items.map((p) => (
        <article key={p.branch} className="soul-record">
          <h4>{p.subject || p.branch}</h4>
          <p className="tone-sources-dim">
            {p.branch} · {p.commit} {p.at ? `· ${new Date(p.at).toLocaleString('zh-CN', { hour12: false })}` : ''}
          </p>
          <p className="tone-sources-dim">{p.stat || '（无统计）'}</p>
          {p.files?.length ? (
            <p className="tone-sources-dim">改了：{p.files.slice(0, 6).join('、')}{p.files.length > 6 ? ` 等 ${p.files.length} 个文件` : ''}</p>
          ) : null}

          <div className="persona-style-row">
            <button className="persona-style-opt" disabled={busy === p.branch} onClick={() => showDiff(p.branch)}>
              {openDiff === p.branch ? '收起改动' : '看改动'}
            </button>
            <button className="persona-style-opt" disabled={busy === p.branch} onClick={() => merge(p.branch)}>合并到主线</button>
            <button className="persona-style-opt" disabled={busy === p.branch} onClick={() => discard(p.branch)}>丢弃</button>
          </div>

          {openDiff === p.branch && (
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, lineHeight: 1.55, maxHeight: 420, overflow: 'auto', margin: '8px 0 0', color: 'var(--pi-dim2)' }}>
              {diff}
            </pre>
          )}
        </article>
      ))}

      {msg ? <p className="tone-sources-dim">{msg}</p> : null}
    </div>
  )
}
