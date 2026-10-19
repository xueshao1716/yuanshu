// 后台调研面板（2026-10-19）：给主题 → 自己去搜 → 交带溯源链接的报告。
import { useCallback, useEffect, useState } from 'react'
import { Search, RefreshCw, X, Loader2 } from 'lucide-react'
import { getApiBase, getToken } from '../api'

type Source = { title: string; url: string; site: string; snippet: string }
type Research = { id: string; topic: string; createdAt: string; status: string; sources: Source[]; report: string; error: string }

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...(init?.headers || {}) },
  })
  return res.json().catch(() => ({}))
}

export default function ResearchPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Research[]>([])
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const j = await api('/api/design-research')
      setItems(Array.isArray(j?.items) ? j.items : [])
    } catch { setError('调研列表读取失败') }
  }, [])

  useEffect(() => { void load() }, [load])

  const run = async () => {
    const t = topic.trim()
    if (!t) { setError('先写一个主题'); return }
    setBusy(true); setError('')
    try {
      const j = await api('/api/design-research', { method: 'POST', body: JSON.stringify({ topic: t }) })
      if (j?.item) { setOpen(j.item.id); await load() }
      else setError(j?.error || '调研没跑成')
    } catch { setError('调研失败（可能被搜索源限流）') } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 sm:p-8" role="dialog" aria-label="后台调研">
      <div className="w-full max-w-[820px] max-h-[86vh] overflow-y-auto rounded-pi-md bg-pi-bg border border-pi-border-soft shadow-xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-pi-border-soft sticky top-0 bg-pi-bg z-10">
          <div>
            <h2 className="text-[14px] font-medium text-pi-text">后台调研</h2>
            <p className="text-[11px] text-pi-dim mt-0.5">给主题 → 自己搜三组查询 → 交带溯源链接的报告</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="btn-tool !min-h-9" onClick={() => void load()} title="刷新"><RefreshCw className="w-3.5 h-3.5" /></button>
            <button type="button" className="btn-tool !min-h-9" onClick={onClose} title="关闭"><X className="w-3.5 h-3.5" /></button>
          </div>
        </header>

        <div className="p-4 border-b border-pi-border-soft flex items-center gap-2">
          <input className="pi-input flex-1" placeholder="调研主题，例如「双11 美妆主视觉」" value={topic}
            onChange={(e) => setTopic(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run() }} />
          <button type="button" className="btn-tool !min-h-9" disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{busy ? '调研中…' : '开始调研'}</span>
          </button>
        </div>

        {error && <p className="px-4 py-2 text-[12px] text-pi-red border-b border-pi-border-soft">{error}</p>}

        <ul className="divide-y divide-pi-border-soft">
          {items.length === 0 && <li className="px-4 py-6 text-[12px] text-pi-dim">还没有调研记录。写个主题点「开始调研」。</li>}
          {items.map((r) => {
            const expanded = open === r.id
            return (
              <li key={r.id} className="px-4 py-3">
                <button type="button" className="w-full text-left" onClick={() => setOpen(expanded ? '' : r.id)}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] text-pi-text">{r.topic}</span>
                    <span className={`text-[11px] ${r.status === 'done' ? 'text-pi-success' : r.status === 'failed' ? 'text-pi-red' : 'text-pi-dim'}`}>
                      {r.status === 'done' ? `${r.sources.length} 条来源` : r.status}
                    </span>
                    <span className="text-[11px] text-pi-dim2">{String(r.createdAt).slice(0, 16).replace('T', ' ')}</span>
                  </div>
                </button>
                {expanded && (
                  <div className="mt-2 space-y-1">
                    {r.sources.length === 0 && <p className="text-[11px] text-pi-dim">{r.error || '没有取到结果。'}</p>}
                    {r.sources.map((s, i) => (
                      <div key={`${s.url}-${i}`} className="text-[11px] leading-snug">
                        <a className="text-pi-accent hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                        <span className="text-pi-dim2"> · {s.site}</span>
                        {s.snippet && <p className="text-pi-dim mt-0.5 line-clamp-2">{s.snippet}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>

        <footer className="px-4 py-2 text-[11px] text-pi-dim border-t border-pi-border-soft">
          来源是公开搜索结果（Bing 静态页），没有内部数据；Pinterest/Behance 只出现在链接里，不会自动抓图。
        </footer>
      </div>
    </div>
  )
}
