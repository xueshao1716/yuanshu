import { useCallback, useEffect, useMemo, useState } from 'react'
import { Film, Search, Settings2, Play, History, X } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import VideoPlayer from '../components/VideoPlayer'
import { api, imageProxyUrl } from '../api'

type Variant = { source: string; sourceName: string; id: string; name: string; pic: string; remarks: string; year: string; type: string }
type Result = { name: string; pic: string; year: string; type: string; variants: Variant[] }
type Episode = { name: string; url: string }
type Group = { name: string; episodes: Episode[] }
type Detail = Variant & { desc: string; groups: Group[] }
type SourceRow = { name: string; url: string; key: string }
type HistoryRow = { name: string; source: string; id: string; group: number; ep: number; t: number; at: number; pic: string }

const HISTORY_KEY = 'yuanshu_tv_history_v1'
const readHistory = (): HistoryRow[] => {
  try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(v) ? v.slice(0, 20) : [] } catch { return [] }
}
const writeHistory = (rows: HistoryRow[]) => { try { localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(0, 20))) } catch {} }
const poster = (url: string) => (url ? imageProxyUrl(url) : undefined)

export default function Tv() {
  const [sources, setSources] = useState<SourceRow[] | null>(null)
  const [managing, setManaging] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Result[] | null>(null)
  const [failed, setFailed] = useState<{ source: string; error: string }[]>([])
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [group, setGroup] = useState(0)
  const [ep, setEp] = useState(0)
  const [startAt, setStartAt] = useState(0)
  const [history, setHistory] = useState<HistoryRow[]>(() => readHistory())

  const loadSources = useCallback(async () => {
    try { setSources((await api<{ sources: SourceRow[] }>('/api/tv/sources')).sources) }
    catch (e) { setSources([]); setError(e instanceof Error ? e.message : '读取片源失败') }
  }, [])
  useEffect(() => { void loadSources() }, [loadSources])

  const saveSources = async () => {
    setSaveError('')
    try {
      const r = await api<{ sources: SourceRow[] }>('/api/tv/sources', { method: 'POST', body: { import: draft.trim() } })
      setSources(r.sources); setManaging(false); setDraft('')
    } catch (e) { setSaveError(e instanceof Error ? e.message : '保存失败') }
  }

  const search = async () => {
    const word = q.trim()
    if (!word) return
    setBusy(true); setError(''); setDetail(null)
    try {
      const r = await api<{ results: Result[]; failed: { source: string; error: string }[]; needSources?: boolean }>(`/api/tv/search?q=${encodeURIComponent(word)}`, { timeoutMs: 30000 })
      setResults(r.results); setFailed(r.failed || [])
    } catch (e) { setError(e instanceof Error ? e.message : '搜索失败') }
    finally { setBusy(false) }
  }

  const open = async (v: { source: string; id: string }, resume?: { group: number; ep: number; t: number }) => {
    setDetailBusy(true); setError('')
    try {
      const d = await api<Detail>(`/api/tv/detail?source=${encodeURIComponent(v.source)}&id=${encodeURIComponent(v.id)}`, { timeoutMs: 20000 })
      if (!d.groups.length) { setError('这个来源没有可直接播放的线路，换一个来源试试'); return }
      setDetail(d); setGroup(resume?.group ?? 0); setEp(resume?.ep ?? 0); setStartAt(resume?.t ?? 0)
    } catch (e) { setError(e instanceof Error ? e.message : '读取详情失败') }
    finally { setDetailBusy(false) }
  }

  const current = detail?.groups[group]?.episodes[ep]
  const remember = useCallback((t: number) => {
    if (!detail) return
    const row: HistoryRow = { name: detail.name, source: detail.source, id: detail.id, group, ep, t: Math.floor(t), at: Date.now(), pic: detail.pic }
    const next = [row, ...readHistory().filter(h => !(h.source === row.source && h.id === row.id))]
    writeHistory(next); setHistory(next.slice(0, 20))
  }, [detail, group, ep])

  const playerKey = useMemo(() => `${detail?.source}:${detail?.id}:${group}:${ep}`, [detail, group, ep])

  if (sources === null) return <div className="flex-1 p-6 text-sm text-pi-dim" role="status">加载中…</div>

  const manager = (
    <section className="panel !p-4 mb-4">
      <p className="text-sm text-pi-dim mb-2">粘贴片源订阅（JSON）。支持 {'{"sources":[{"name","api"}]}'} 或 [{'{"name","url"}'}] 两种格式；仓库不内置任何片源，片源与使用责任由你自己决定。</p>
      <textarea className="input-pi w-full min-h-32 text-xs font-mono" value={draft} onChange={e => setDraft(e.target.value)} placeholder='{"sources":[{"name":"示例","api":"https://example.com/api.php/provide/vod"}]}' aria-label="片源订阅 JSON" />
      {saveError && <p role="alert" className="text-xs text-pi-danger mt-1">{saveError}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="btn-primary min-h-11 px-4" disabled={!draft.trim()} onClick={saveSources}>保存片源</button>
        {sources.length > 0 && <button type="button" className="btn-ghost min-h-11 px-3" onClick={() => { setManaging(false); setSaveError('') }}>取消</button>}
      </div>
      {sources.length > 0 && <p className="text-xs text-pi-dim2 mt-2">当前 {sources.length} 个片源：{sources.map(s => s.name).join('、')}（保存会整体替换）</p>}
    </section>
  )

  const actions = <button type="button" className="btn-ghost min-h-11 px-3 inline-flex items-center gap-1.5" onClick={() => setManaging(m => !m)}><Settings2 className="w-4 h-4" />片源{sources.length ? ` ${sources.length}` : ''}</button>

  return (
    <div className="flex-1 overflow-y-auto relative z-10">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
        <PageHeader title="影视" description="搜索并在线观看；对话里贴 m3u8 / mp4 链接也会直接内嵌播放。" actions={actions} />
        {(managing || !sources.length) && manager}
        {!!sources.length && (
          <form className="flex gap-2 mb-4" onSubmit={e => { e.preventDefault(); void search() }}>
            <input className="input-pi flex-1 min-h-11" value={q} onChange={e => setQ(e.target.value)} placeholder="搜索片名" aria-label="搜索片名" enterKeyHint="search" />
            <button type="submit" className="btn-primary min-h-11 px-4 inline-flex items-center gap-1.5" disabled={busy || !q.trim()}><Search className="w-4 h-4" />{busy ? '搜索中…' : '搜索'}</button>
          </form>
        )}
        {error && <p role="alert" className="text-sm text-pi-danger mb-3 break-words">{error}</p>}

        {detail && current && (
          <section className="panel !p-3.5 mb-5" aria-label="播放">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold truncate">{detail.name}</h2>
                <p className="text-xs text-pi-dim2 truncate">{[detail.sourceName, detail.year, detail.type, detail.remarks].filter(Boolean).join(' · ')}</p>
              </div>
              <button type="button" className="btn-tool min-h-11 shrink-0" aria-label="关闭播放" onClick={() => setDetail(null)}><X className="w-4 h-4" /></button>
            </div>
            <VideoPlayer key={playerKey} src={current.url} poster={poster(detail.pic)} title={`${detail.name} ${current.name}`} autoPlay startAt={startAt}
              onProgress={t => remember(t)}
              onEnded={() => { const next = detail.groups[group].episodes[ep + 1]; if (next) { setEp(ep + 1); setStartAt(0) } }} />
            {detail.groups.length > 1 && (
              <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="线路">
                {detail.groups.map((g, i) => <button key={g.name + i} type="button" role="tab" aria-selected={i === group} className={`btn-tool min-h-11 px-3 text-xs ${i === group ? '!text-pi-accent' : ''}`} onClick={() => { setGroup(i); setEp(Math.min(ep, g.episodes.length - 1)); setStartAt(0) }}>{g.name}</button>)}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5 max-h-48 overflow-y-auto" aria-label="选集">
              {detail.groups[group].episodes.map((e, i) => <button key={e.name + i} type="button" aria-current={i === ep} className={`btn-tool min-h-11 px-3 text-xs ${i === ep ? '!text-pi-accent' : ''}`} onClick={() => { setEp(i); setStartAt(0) }}>{e.name}</button>)}
            </div>
            {detail.desc && <p className="mt-3 text-xs text-pi-dim leading-relaxed line-clamp-4">{detail.desc}</p>}
          </section>
        )}
        {detailBusy && <p className="text-sm text-pi-dim mb-3" role="status">正在读取线路…</p>}

        {results && (
          results.length === 0
            ? <EmptyState icon={Film} title="没有找到" hint={failed.length ? `${failed.length} 个片源没有响应，换个关键词或稍后再试。` : '换个关键词试试。'} className="py-16" />
            : (
              <section aria-label="搜索结果">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {results.map(r => (
                    <article key={r.name} className="panel !p-2 flex flex-col gap-1.5">
                      <button type="button" className="text-left" onClick={() => void open(r.variants[0])} aria-label={`播放 ${r.name}`}>
                        <div className="aspect-[2/3] rounded-pi-md bg-pi-bg2 overflow-hidden">
                          {r.pic && <img src={poster(r.pic)} alt="" loading="lazy" className="w-full h-full object-cover" />}
                        </div>
                        <div className="mt-1.5 text-sm font-medium line-clamp-2">{r.name}</div>
                        <div className="text-[11px] text-pi-dim2 truncate">{[r.year, r.type, r.variants[0].remarks].filter(Boolean).join(' · ')}</div>
                      </button>
                      {r.variants.length > 1 && (
                        <div className="flex flex-wrap gap-1">
                          {r.variants.map(v => <button key={v.source} type="button" className="btn-tool-sm touch-hit" onClick={() => void open(v)}>{v.sourceName}</button>)}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                {failed.length > 0 && <p className="text-[11px] text-pi-dim2 mt-3">未响应：{failed.map(f => f.source).join('、')}</p>}
              </section>
            )
        )}

        {!results && !!sources.length && history.length > 0 && (
          <section aria-label="继续观看">
            <h2 className="text-sm font-medium text-pi-dim mb-2 inline-flex items-center gap-1.5"><History className="w-4 h-4" />继续观看</h2>
            <div className="space-y-2">
              {history.map(h => (
                <button key={h.source + h.id} type="button" className="panel !p-2.5 w-full flex items-center gap-3 text-left min-h-11" onClick={() => void open(h, h)}>
                  <Play className="w-4 h-4 shrink-0 text-pi-accent" />
                  <span className="min-w-0 flex-1 truncate text-sm">{h.name}</span>
                  <span className="text-[11px] text-pi-dim2 shrink-0">第 {h.ep + 1} 集 · {Math.floor(h.t / 60)}:{String(h.t % 60).padStart(2, '0')}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
