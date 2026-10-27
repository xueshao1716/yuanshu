import useSWR from 'swr'
import { useState } from 'react'
import { api } from '../api'

/**
 * 记忆 Wiki（2026-10-27）
 *
 * 抄 A5 的 Workspace Wiki / EverOS 的 Knowledge Wiki：把散在记忆、经验库、知识库里的东西
 * 按主题摊开成**人能读**的页面。点开能看正文，可以重建；手写过的页（删掉自动标记）不会被覆盖。
 */
type Item = { name: string; bytes: number; updatedAt: number }
type Stale = Record<string, { at: number; because: string[]; generated?: boolean }>

const WikiApi = {
  list: () => api<{ ok: boolean; items: Item[]; index: string; stale?: Stale }>('/api/wiki'),
  page: (topic: string) => api<{ ok: boolean; content?: string; error?: string }>(`/api/wiki/${encodeURIComponent(topic)}`),
  rebuild: () => api<{ ok: boolean; written: string[]; kept: string[]; topics: number }>('/api/wiki/rebuild', { method: 'POST' }),
}

const btn = (primary = false): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minHeight: 30, padding: '0 12px', borderRadius: 999, fontSize: 12, lineHeight: 1, cursor: 'pointer',
  border: `1px solid ${primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-border-soft, #bfc4cb)'}`,
  background: primary ? 'var(--pi-accent-soft, rgba(47,107,255,0.12))' : 'var(--pi-bg3, #eef0f3)',
  color: primary ? 'var(--pi-accent, #2f6bff)' : 'var(--pi-text, #222)',
  fontWeight: primary ? 600 : 400,
})

export default function WikiCard() {
  const { data, mutate, isLoading } = useSWR('memory-wiki', () => WikiApi.list(), { refreshInterval: 120000 })
  const [open, setOpen] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const items = (data?.items || []).filter((x) => x.name !== 'index')
  const stale = data?.stale || {}
  // 只有手写页需要人处理；自动页下次重建会自己刷新
  const staleHand = Object.values(stale).filter((x) => !x.generated).length

  const show = async (name: string) => {
    if (open === name) { setOpen(null); return }
    setBusy(name); setMsg('')
    try {
      const r = await WikiApi.page(name)
      if (!r.ok) { setMsg(r.error || '读不到'); return }
      setContent(r.content || '')
      setOpen(name)
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  const rebuild = async () => {
    setBusy('__rebuild')
    try {
      const r = await WikiApi.rebuild()
      setMsg(`重建完成：更新 ${r.written?.length || 0} 页，保留手写 ${r.kept?.length || 0} 页`)
      await mutate()
    } catch (e: any) { setMsg(String(e?.message || e).slice(0, 120)) }
    finally { setBusy('') }
  }

  if (isLoading) return <p className="tone-sources-dim">读取中…</p>
  if (!items.length) {
    return (
      <div>
        <p className="tone-sources-dim">还没有生成过。点下面按钮，把记忆/经验/知识聚合成主题页。</p>
        <button type="button" style={btn(true)} disabled={busy === '__rebuild'} onClick={rebuild}>生成 Wiki</button>
        {msg ? <p className="tone-sources-dim">{msg}</p> : null}
      </div>
    )
  }

  return (
    <div className="tone-sources">
      <p className="tone-sources-line">
        <strong>{items.length}</strong> 个主题页（给人看的，不是给模型塞的）。
        删掉页面顶部的自动标记，那一页就归你，我不再覆盖。
        {staleHand > 0 ? (
          <span style={{ color: 'var(--pi-warn, #d97706)', marginLeft: 6 }}>
            ⚠ {staleHand} 个手写页待复核：来源文档改过，手写页不会自动更新。
          </span>
        ) : null}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {items.map((it) => (
          <button key={it.name} type="button" style={btn(open === it.name)} disabled={busy === it.name} onClick={() => show(it.name)}>
            {stale[it.name] && !stale[it.name].generated ? '⚠ ' : ''}{it.name}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={btn()} disabled={busy === '__rebuild'} onClick={rebuild}>重建</button>
        {open ? <button type="button" style={btn()} onClick={() => setOpen(null)}>收起</button> : null}
      </div>

      {open && (
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.6, maxHeight: 420, overflow: 'auto', margin: '10px 0 0', color: 'var(--pi-dim2)' }}>
          {content}
        </pre>
      )}
      {msg ? <p className="tone-sources-dim">{msg}</p> : null}
    </div>
  )
}
