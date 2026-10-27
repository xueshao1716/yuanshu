import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'

/**
 * 小语自己改的地方（2026-10-28 改版）
 *
 * 用户反馈：「自动补丁这个界面有点工程化，不够工作化」
 * 改法：不提分支/commit，只说人话——改了什么、影响多大、你点哪个。
 * 三个动作：看看改了什么 / 用上这个改动 / 不要这个改动。
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
  list: () => api<{ ok: boolean; error?: string; items: Patch[]; state?: Record<string, { state: string; files: number; ageDays: number | null; reasons: string[] }> }>('/api/autopatch/patches'),
  diff: (branch: string) => api<{ ok: boolean; diff?: string; error?: string; truncated?: boolean }>(
    `/api/autopatch/diff?branch=${encodeURIComponent(branch)}`),
  merge: (branch: string) => api<{ ok: boolean; error?: string }>('/api/autopatch/merge', { method: 'POST', body: { branch } }),
  discard: (branch: string) => api<{ ok: boolean; error?: string }>('/api/autopatch/discard', { method: 'POST', body: { branch } }),
}

const btn = (primary = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minHeight: 32, padding: '0 14px', borderRadius: 999, fontSize: 12.5, lineHeight: 1, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-border-soft, #bfc4cb)'}`,
  background: primary ? 'var(--pi-accent-soft, rgba(47,107,255,0.12))' : 'var(--pi-bg3, #eef0f3)',
  color: primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-text, #222)',
  fontWeight: primary ? 600 : 400,
})

/** 把 `+115 −13` 说成人话；认不出来就不说。 */
function humanStat(stat: string): string {
  const m = String(stat || '').match(/(\d+)\s+files? changed,\s*(\d+)\s+insertions?\(\+\)(?:,\s*(\d+)\s+deletions?\(-\))?/i);
  if (!m) return String(stat || '')
  const [, files, ins, del] = m
  return `改了 ${files} 个文件，加了 ${ins} 行${del ? `、删了 ${del} 行` : ''}`
}

/** 去掉技术前缀，只留一句人话。 */
function cleanSubject(s: string): string {
  return String(s || '')
    .replace(/^autopatch\([^)]*\):\s*/i, '')
    .replace(/^\[[^\]]*\]\s*/, '[分类] ')
    .trim()
}

export default function AutoPatchCard() {
  const { data, mutate, isLoading } = useSWR('autopatch-patches', () => PatchApi.list(), { refreshInterval: 60000 })
  const state = data?.state || {}
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
      if (!r.ok) { setMsg(r.error || '读不到改动内容'); return }
      setDiff(r.diff || '')
      setOpenDiff(branch)
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  const merge = async (branch: string) => {
    if (!window.confirm('用上这个改动？\n确认后它就会生效。')) return
    setBusy(branch); setMsg('')
    try {
      const r = await PatchApi.merge(branch)
      setMsg(r.ok ? '✓ 已用上' : (r.error || '没成功'))
      await mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  const discard = async (branch: string) => {
    if (!window.confirm('不要这个改动了？\n删掉之后系统还是原来的样子。')) return
    setBusy(branch); setMsg('')
    try {
      const r = await PatchApi.discard(branch)
      setMsg(r.ok ? '✓ 已丢掉' : (r.error || '没成功'))
      await mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>
  if (data && data.ok === false) return <p className="tone-sources-dim">{data.error || '暂时读不到'}</p>
  if (!items.length) {
    return (
      <div className="tone-sources">
        <p className="tone-sources-line">
          现在没有要你点头的改动。
        </p>
        <p className="tone-sources-dim">
          小语自己动手改完代码后，会先把改动放在这里等你看——<strong>在你说“用上”之前，什么都不会变</strong>。
        </p>
      </div>
    )
  }

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        有 <strong>{items.length}</strong> 处改动等你看。
        <span className="tone-sources-dim">这些改动还没生效，点「用上」才算数。</span>
      </p>

      {items.map((p) => {
        const st = state[p.branch]
        return (
          <article key={p.branch} className="soul-record">
            <h4 style={{ fontWeight: 600 }}>
              {cleanSubject(p.subject)}
              {st ? (
                <span
                  style={{
                    marginLeft: 8, fontSize: 11, padding: '1px 7px', borderRadius: 999,
                    border: '1px solid var(--pi-border-soft, #bfc4cb)',
                    color: st.state === 'stale' ? 'var(--pi-warn, #d97706)' : 'var(--pi-dim2)',
                    fontWeight: 400,
                  }}
                >
                  {st.state === 'stale' ? '放了几天了' : '等你决定'}
                </span>
              ) : null}
            </h4>

            <p className="tone-sources-dim">
              {humanStat(p.stat)}
              {p.at ? ` · ${new Date(p.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
            </p>

            {p.files?.length ? (
              <details style={{ marginTop: 2 }}>
                <summary className="tone-sources-dim" style={{ cursor: 'pointer', fontSize: 12 }}>
                  涉及 {p.files.length} 个文件
                </summary>
                <p className="tone-sources-dim" style={{ marginTop: 4, fontSize: 12 }}>
                  {p.files.slice(0, 12).join('、')}{p.files.length > 12 ? ` 等 ${p.files.length} 个` : ''}
                </p>
              </details>
            ) : null}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <button type="button" style={btn()} disabled={busy === p.branch} onClick={() => showDiff(p.branch)}>
                {openDiff === p.branch ? '收起' : '看看改了什么'}
              </button>
              <button type="button" style={btn(true)} disabled={busy === p.branch} onClick={() => merge(p.branch)}>
                用上这个改动
              </button>
              <button type="button" style={btn()} disabled={busy === p.branch} onClick={() => discard(p.branch)}>
                不要这个改动
              </button>
            </div>

            {openDiff === p.branch && (
              <>
                <p className="tone-sources-dim" style={{ marginTop: 8, fontSize: 12 }}>
                  下面是逐行的代码对比（<span style={{ color: 'var(--pi-success, #16a34a)' }}>绿色是加的</span>、
                  <span style={{ color: 'var(--pi-danger, #dc2626)' }}>红色是删的</span>）。看不懂也没关系，直接决定用不用就行。
                </p>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11.5, lineHeight: 1.55, maxHeight: 420, overflow: 'auto', margin: '6px 0 0', color: 'var(--pi-dim2)' }}>
                  {diff}
                </pre>
              </>
            )}
          </article>
        )
      })}

      {msg ? <p className="tone-sources-dim">{msg}</p> : null}
    </div>
  )
}
