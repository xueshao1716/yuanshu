import ThemedSelect from '../components/ThemedSelect'
import { useEffect, useMemo, useState } from 'react'
import { Database, RefreshCw, Search, Trash2, Pin, CheckSquare, Square, Pencil, ExternalLink, MessagesSquare, Brain } from 'lucide-react'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import { toast } from '../components/Toast'
import { useApp } from '../store'
import { api, SessionsApi, RecallApi } from '../api'

// ── 会话数据库（08-29 真落地）：编号/健康度/大小/批量清理 ──
// 后端 /api/sessions/db/*；健康 ok<1MB / large 1-5MB / oversized>5MB

type Row = {
  id: string; name: string; cwd: string; sizeBytes: number
  health: 'ok' | 'large' | 'oversized'; messageCount: number | null
  createdAt?: string | null; updatedAt?: string | null
  mtime: string | null; seq: number | null; pinned: boolean; tags: string[]
}
type Stats = { total: number; totalMB: number; health: Record<string, number>; lastRebuild: string | null }

const HEALTH: Record<string, { label: string; cls: string }> = {
  ok: { label: '正常', cls: 'bg-pi-success/15 text-pi-success' },
  large: { label: '偏大', cls: 'bg-pi-warning/15 text-pi-warning' },
  oversized: { label: '超限', cls: 'bg-pi-danger/15 text-pi-danger' },
}

function fmtSize(b: number) { return !b ? '—' : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB` }
function fmtTime(t: string | null) {
  if (!t) return '—'
  try {
    const d = new Date(t)
    if (!Number.isFinite(d.getTime())) return '—'
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch { return '—' }
}

function rowTime(r: Row) {
  for (const value of [r.updatedAt, r.mtime, r.createdAt]) {
    if (!value) continue
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return ms
  }
  return -Infinity
}

function compareRows(a: Row, b: Row) {
  const pinned = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
  if (pinned) return pinned
  const byTime = rowTime(b) - rowTime(a)
  if (byTime) return byTime
  // 时间完全相同时才用稳定编号；编号不再决定新旧排序。
  const bySeq = (b.seq || 0) - (a.seq || 0)
  if (bySeq) return bySeq
  return a.id.localeCompare(b.id)
}

export default function SessionDb({ embedded = false }: { embedded?: boolean } = {}) {
  const { selectSession, currentSessionId } = useApp()
  const [rows, setRows] = useState<Row[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('')
  const [sortMode, setSortMode] = useState<'recent' | 'oldest' | 'seq-asc' | 'seq-desc'>('recent')
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [sums, setSums] = useState<Record<string, string>>({})
  const [sumBusy, setSumBusy] = useState(false)

  const load = async () => {
    const d = await api('/api/sessions/db/list').catch(() => null)
    if (d?.sessions) setRows(d.sessions)
    setStats(await api('/api/sessions/db/stats').catch(() => null))
    const s = await RecallApi.summaries().catch(() => null)
    if (s?.summaries) setSums(s.summaries)
  }
  useEffect(() => { load() }, [])

  const rebuild = async () => {
    setBusy(true)
    const d = await api('/api/sessions/db/rebuild', { method: 'POST' }).catch(() => null)
    setBusy(false)
    if (d?.ok) { toast(`索引完成：${d.total} 条，新增编号 ${d.added}`, 'ok'); await load() }
    else toast('重建失败', 'error')
  }

  const sweepEmpty = async () => {
    setBusy(true)
    const d = await api('/api/sessions/db/sweep', { method: 'POST', body: { minAgeMs: 0 } }).catch(() => null)
    setBusy(false)
    if (d?.ok) { toast(`已清理 ${d.swept} 条空会话（可从回收站找回）`, 'ok'); await load() }
    else toast('清理失败', 'error')
  }

  const batchSanitize = async () => {
    if (!sel.size) return
    setBusy(true)
    const d = await api('/api/sessions/db/sanitize', { method: 'POST', body: { ids: [...sel] } }).catch(() => null)
    setBusy(false)
    if (d?.ok) {
      const saved = d.results.reduce((a: number, r: any) => a + (r.bytesSaved || 0), 0)
      const patched = d.results.reduce((a: number, r: any) => a + (r.linesPatched || 0), 0)
      toast(`清理完成：${patched} 条消息截断，省 ${(saved / 1048576).toFixed(1)}MB`, 'ok')
      setSel(new Set()); await load()
    } else toast('清理失败', 'error')
  }

  const togglePin = async (r: Row) => {
    const d = await api('/api/sessions/db/meta', { method: 'PATCH', body: { id: r.id, pinned: !r.pinned } }).catch(() => null)
    if (d?.ok) setRows(rows.map(x => x.id === r.id ? { ...x, pinned: d.pinned, seq: d.seq } : x))
  }

  // 打开会话：选中 + 跳回对话页（移动端同样生效，TabBar 对话入口自动点亮）
  const openSession = (r: Row) => {
    selectSession(r.id)
    if (location.hash !== '#/chat') location.hash = '#/chat'
  }

  const submitRename = async () => {
    if (!renaming?.name.trim()) { setRenaming(null); return }
    const d = await SessionsApi.rename(renaming.id, renaming.name.trim()).catch(() => null)
    if (d?.ok) {
      setRows(rows.map(x => x.id === renaming.id ? { ...x, name: renaming.name.trim() } : x))
      toast('已重命名', 'ok')
    } else toast('重命名失败', 'error')
    setRenaming(null)
  }

  // 两段式删除：第一次点变红要求确认，再点才执行，避免误删；不引入新弹窗组件
  const handleDelete = async (r: Row) => {
    if (confirmingId !== r.id) { setConfirmingId(r.id); setTimeout(() => setConfirmingId(cur => cur === r.id ? null : cur), 3000); return }
    setConfirmingId(null)
    const d = await SessionsApi.remove(r.id).catch(() => null)
    if (d?.ok) { toast(`已删除「${r.name}」`, 'ok'); setSel(prev => { const n = new Set(prev); n.delete(r.id); return n }); await load() }
    else toast('删除失败', 'error')
  }

  const visible = useMemo(() => {
    const filtered = rows.filter(r => (!filter || r.health === filter) && (!q || r.name.toLowerCase().includes(q.toLowerCase()) || String(r.seq || '').includes(q)))
    return filtered.sort((a, b) => {
      const pinned = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      if (pinned) return pinned
      if (sortMode === 'seq-asc') return (a.seq || Number.MAX_SAFE_INTEGER) - (b.seq || Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)
      if (sortMode === 'seq-desc') return (b.seq || 0) - (a.seq || 0) || a.id.localeCompare(b.id)
      const byTime = rowTime(b) - rowTime(a)
      return (sortMode === 'oldest' ? -byTime : byTime) || a.id.localeCompare(b.id)
    })
  }, [rows, q, filter, sortMode])

  const hcls = (h: string) => HEALTH[h]?.cls || HEALTH.ok.cls

  return (
    <div className={embedded ? "session-db-page" : "h-full overflow-y-auto session-db-page"}>
    <div className={embedded ? "session-db-reading" : "session-db-reading mx-auto px-4 sm:px-6 py-5 sm:py-7"}>
        {embedded
          ? <div className="mb-3">{stats ? (
            <div className="text-[11px] text-pi-dim2">
              共 <b className="text-pi-text">{stats.total}</b> 条 · 占用 <b className="text-pi-text">{stats.totalMB}MB</b> · 正常 {stats.health.ok} / 偏大 {stats.health.large} / 超限 {stats.health.oversized}
            </div>
          ) : <span className="text-[11px] text-pi-dim2">加载中…</span>}</div>
          : <PageHeader
          title="会话数据库"
          description="按稳定编号查看会话体量与健康状态，并对选中会话执行安全清理。"
          meta={stats ? (
            <div className="text-[11px] text-pi-dim2">
              共 <b className="text-pi-text">{stats.total}</b> 条 · 占用 <b className="text-pi-text">{stats.totalMB}MB</b> · 正常 {stats.health.ok} / 偏大 {stats.health.large} / 超限 {stats.health.oversized}
            </div>
          ) : <span className="text-[11px] text-pi-dim2">加载中…</span>}
        />}

        {/* 工具条 */}
        <div className="session-db-toolbar flex flex-wrap items-center gap-2 mb-4">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-pi-dim2" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜名称或编号…" aria-label="搜索会话名称或编号"
              className="w-full input-pi !py-1.5 !pl-8 text-[13px]" />
          </div>
          <ThemedSelect value={filter} onChange={e => setFilter(e.target.value)} aria-label="筛选会话健康状态" className="input-pi !py-1.5 text-[13px] w-24">
            <option value="">全部</option>
            <option value="ok">正常</option>
            <option value="large">偏大</option>
            <option value="oversized">超限</option>
          </ThemedSelect>
          <ThemedSelect value={sortMode} onChange={e => setSortMode(e.target.value as typeof sortMode)} aria-label="会话排序方式" className="input-pi !py-1.5 text-[13px] w-32">
            <option value="recent">最近更新</option>
            <option value="oldest">最早更新</option>
            <option value="seq-asc">编号升序</option>
            <option value="seq-desc">编号降序</option>
          </ThemedSelect>
          <button onClick={rebuild} disabled={busy} className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />重建索引
          </button>
          <button onClick={sweepEmpty} disabled={busy} className="btn-ghost text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
            <Trash2 className="w-3.5 h-3.5" />清理空会话
          </button>
          {sel.size > 0 && (
            <button onClick={batchSanitize} disabled={busy} className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5">
              <Trash2 className="w-3.5 h-3.5" />清理所选（{sel.size}）
            </button>
          )}
        </div>

        {/* 跨会话回忆（闭环第三件）：问过去，带出处 */}
        <RecallPanel onOpenSession={openSession} sums={sums} sumBusy={sumBusy}
          onGenSums={async () => {
            setSumBusy(true)
            try {
              const before = Object.keys(sums).length
              await RecallApi.summarize() // fire-and-forget：后台逐个生成，轮询看进度
              toast('摘要生成已在后台开始（每次 5 个，约 3-5 分钟），完成后会话名下自动出现', 'ok')
              const timer = setInterval(async () => {
                const s = await RecallApi.summaries().catch(() => null)
                if (s?.summaries && Object.keys(s.summaries).length > before) {
                  clearInterval(timer); setSums(s.summaries); setSumBusy(false); toast('摘要批次完成', 'ok')
                }
              }, 15000)
              const stopSummaryPolling = () => { clearInterval(timer); setSumBusy(false) }
              setTimeout(stopSummaryPolling, 10 * 60_000) // 10 分钟兜底
            } catch (e: any) { toast('启动失败：' + (e?.message || e), 'error'); setSumBusy(false) }
          }} />

        {!visible.length ? (
          <EmptyState icon={Database} title="没有匹配的会话" hint="调整搜索或健康筛选，也可以重建索引后再试。" />
        ) : (
          <>
            {/* 桌面表格 */}
            <div data-slot="session-db-table" className="session-db-table hidden md:block overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-pi-dim2 border-b border-pi-border">
                    <th className="p-2.5 w-8">
                      <button onClick={() => setSel(sel.size ? new Set() : new Set(visible.map(r => r.id)))} title="全选" aria-label="选择全部可见会话">
                        {sel.size && sel.size === visible.length ? <CheckSquare className="w-4 h-4 text-pi-accent" /> : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="p-2.5 w-14">#</th>
                    <th className="p-2.5">名称</th>
                    <th className="p-2.5 w-16">健康</th>
                    <th className="p-2.5 w-20 text-right">大小</th>
                    <th className="p-2.5 w-16 text-right">消息</th>
                    <th className="p-2.5 w-24">更新</th>
                    <th className="p-2.5 w-32"></th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => (
                    <tr key={r.id} className={`border-b border-pi-border-soft hover:bg-pi-bg-hover ${sel.has(r.id) ? 'bg-pi-accent-soft' : ''} ${r.health === 'oversized' ? 'opacity-90' : ''}`}>
                      <td className="p-2.5">
                        <button aria-label={`选择会话 ${r.name}`} onClick={() => { const n = new Set(sel); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setSel(n) }}>
                          {sel.has(r.id) ? <CheckSquare className="w-4 h-4 text-pi-accent" /> : <Square className="w-4 h-4 text-pi-dim2" />}
                        </button>
                      </td>
                      <td className="p-2.5 font-mono text-pi-dim">#{r.seq ?? '—'}</td>
                      <td className="p-2.5 text-pi-text truncate max-w-[240px]" title={r.name}>
                        {renaming?.id === r.id ? (
                          <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: r.id, name: e.target.value })}
                            onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
                            onBlur={submitRename} aria-label="重命名会话"
                            className="input-pi !py-1 text-[13px] w-full" />
                        ) : (
                          <button onClick={() => openSession(r)} className="inline-flex items-center gap-1.5 hover:text-pi-accent transition-colors text-left min-w-0" title="打开会话">
                            {r.pinned && <Pin className="w-3.5 h-3.5 text-pi-warning fill-pi-warning" aria-label="已置顶" />}
                            <span className="truncate">{r.name}</span>
                            {r.id === currentSessionId && <span className="flex-shrink-0 px-1.5 py-0.5 rounded-pi-pill bg-pi-accent/15 text-pi-accent text-[10px]">当前</span>}
                          </button>
                        )}
                        {sums[r.id] && !renaming?.id && sums[r.id] !== '(过短会话)' && <div className="text-[10px] text-pi-dim2 truncate max-w-[280px] mt-0.5" title={`摘要：${sums[r.id]}`}>{sums[r.id]}</div>}
                      </td>
                      <td className="p-2.5"><span className={`px-1.5 py-0.5 rounded-pi-sm text-[10px] font-medium ${hcls(r.health)}`}>{HEALTH[r.health]?.label}</span></td>
                      <td className="p-2.5 text-right font-mono text-pi-dim text-[11px]">{fmtSize(r.sizeBytes)}</td>
                      <td className="p-2.5 text-right font-mono text-pi-dim text-[11px]">{r.messageCount ?? '—'}</td>
                      <td className="p-2.5 text-pi-dim2 font-mono text-[11px]">{fmtTime(r.mtime)}</td>
                      <td className="p-2.5">
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => openSession(r)} className="p-1 rounded-pi-sm hover:bg-pi-bg3 text-pi-dim2 hover:text-pi-text" title="打开会话" aria-label={`打开会话 ${r.name}`}><ExternalLink className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setRenaming({ id: r.id, name: r.name })} className="p-1 rounded-pi-sm hover:bg-pi-bg3 text-pi-dim2 hover:text-pi-text" title="重命名" aria-label={`重命名会话 ${r.name}`}><Pencil className="w-3.5 h-3.5" /></button>
                          <button onClick={() => togglePin(r)} className={`p-1 rounded-pi-sm hover:bg-pi-bg3 ${r.pinned ? 'text-pi-warning' : 'text-pi-dim2'}`} title={r.pinned ? '取消置顶' : '置顶'} aria-label={`${r.pinned ? '取消置顶' : '置顶'} ${r.name}`}>
                            <Pin className={`w-3.5 h-3.5 ${r.pinned ? 'fill-pi-warning' : ''}`} />
                          </button>
                          <button onClick={() => handleDelete(r)} className={`p-1 rounded-pi-sm hover:bg-pi-bg3 ${confirmingId === r.id ? 'text-pi-red' : 'text-pi-dim2 hover:text-pi-red'}`} title={confirmingId === r.id ? '再点一次确认删除' : '删除'} aria-label={`删除会话 ${r.name}`}>
                            <Trash2 className={`w-3.5 h-3.5 ${confirmingId === r.id ? 'animate-pulse' : ''}`} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 移动卡片 */}
            <div data-slot="session-db-cards" className="md:hidden space-y-2.5">
              {visible.map(r => (
                <article key={r.id} className={`panel !p-3.5 ${sel.has(r.id) ? 'border-pi-accent/50 bg-pi-accent-soft' : ''}`}>
                  <div className="flex items-start gap-3">
                    <button className="min-h-11 min-w-11 -ml-2 -mt-2 inline-flex items-center justify-center flex-shrink-0 rounded-pi-md hover:bg-pi-bg3" aria-label={`选择会话 ${r.name}`} onClick={() => { const n = new Set(sel); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setSel(n) }}>
                      {sel.has(r.id) ? <CheckSquare className="w-5 h-5 text-pi-accent" /> : <Square className="w-5 h-5 text-pi-dim2" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 text-[11px] text-pi-dim2 font-mono">
                            {r.pinned && <Pin className="w-3 h-3 text-pi-warning fill-pi-warning" aria-label="已置顶" />}
                            <span>编号 #{r.seq ?? '—'}</span>
                            {r.id === currentSessionId && <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-accent/15 text-pi-accent text-[10px] font-sans">当前</span>}
                          </div>
                          {renaming?.id === r.id ? (
                            <input autoFocus value={renaming.name} onChange={e => setRenaming({ id: r.id, name: e.target.value })}
                              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(null) }}
                              onBlur={submitRename} aria-label="重命名会话"
                              className="input-pi !py-1 text-[13px] w-full mt-1" />
                          ) : (
                            <button onClick={() => openSession(r)} className="mt-1 text-left min-w-0 w-full" title="打开会话">
                              <h2 className="text-[13px] font-medium text-pi-text break-words hover:text-pi-accent transition-colors">{r.name}</h2>
                              {sums[r.id] && sums[r.id] !== '(过短会话)' && <div className="text-[10px] text-pi-dim2 mt-0.5" title={`摘要：${sums[r.id]}`}>{sums[r.id]}</div>}
                            </button>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5 flex-shrink-0">
                          <div className="flex items-center">
                            <button onClick={() => openSession(r)} className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-pi-md hover:bg-pi-bg3 text-pi-dim2 hover:text-pi-text" aria-label={`打开会话 ${r.name}`} title="打开会话"><ExternalLink className="w-4 h-4" /></button>
                            <button onClick={() => setRenaming({ id: r.id, name: r.name })} className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-pi-md hover:bg-pi-bg3 text-pi-dim2 hover:text-pi-text" aria-label={`重命名会话 ${r.name}`} title="重命名"><Pencil className="w-4 h-4" /></button>
                          </div>
                          <div className="flex items-center">
                            <button onClick={() => togglePin(r)} className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-pi-md hover:bg-pi-bg3 ${r.pinned ? 'text-pi-warning' : 'text-pi-dim2'}`} aria-label={`${r.pinned ? '取消置顶' : '置顶'} ${r.name}`} title={r.pinned ? '取消置顶' : '置顶'}>
                              <Pin className={`w-4 h-4 ${r.pinned ? 'fill-pi-warning' : ''}`} />
                            </button>
                            <button onClick={() => handleDelete(r)} className={`min-h-11 min-w-11 inline-flex items-center justify-center rounded-pi-md hover:bg-pi-bg3 ${confirmingId === r.id ? 'text-pi-red' : 'text-pi-dim2 hover:text-pi-red'}`} aria-label={`删除会话 ${r.name}`} title={confirmingId === r.id ? '再点一次确认删除' : '删除'}>
                              <Trash2 className={`w-4 h-4 ${confirmingId === r.id ? 'animate-pulse' : ''}`} />
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3 text-[11px]">
                        <div><span className="text-pi-dim2">健康</span><div className="mt-0.5"><span className={`px-1.5 py-0.5 rounded-pi-sm text-[10px] font-medium ${hcls(r.health)}`}>{HEALTH[r.health]?.label}</span></div></div>
                        <div><span className="text-pi-dim2">大小</span><div className="mt-0.5 font-mono text-pi-dim">{fmtSize(r.sizeBytes)}</div></div>
                        <div><span className="text-pi-dim2">消息</span><div className="mt-0.5 font-mono text-pi-dim">{r.messageCount ?? '—'}</div></div>
                        <div><span className="text-pi-dim2">更新</span><div className="mt-0.5 font-mono text-pi-dim">{fmtTime(r.mtime)}</div></div>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
        <p className="session-db-footnote text-[12px] text-pi-dim2 mt-5">点击名称打开会话；清理会截断超大推理签名和工具结果，防止上游 400 / 502；不会删除对话正文。删除会话请用行内删除按钮（两段确认）。</p>
      </div>
    </div>
  )
}

// ══ 跨会话回忆（09-04，Hermes 闭环第三件）：「上次那事怎么解决的？」══
// bigram 倒排检索全量会话片段 → LLM 综合回答（注明来源会话）。只读，绝不写会话文件。
function RecallPanel({ onOpenSession, sums, sumBusy, onGenSums }: { onOpenSession?: (r: Row) => void; sums?: Record<string, string>; sumBusy?: boolean; onGenSums?: () => void }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [hits, setHits] = useState<any[]>([])
  const [stats, setStats] = useState<{ sessions: number; snippets: number } | null>(null)
  const [building, setBuilding] = useState(false)

  useEffect(() => { RecallApi.stats().then(setStats).catch(() => {}) }, [])
  const buildIndex = async () => {
    setBuilding(true)
    try {
      const r = await RecallApi.rebuild()
      toast(`索引完成：${r.total} 会话 → ${r.snippets} 片段`, 'ok')
      setStats({ sessions: r.total, snippets: r.snippets })
    } catch { toast('索引构建失败', 'error') } finally { setBuilding(false) }
  }
  const ask = async () => {
    if (!q.trim() || busy) return
    setBusy(true); setAnswer(''); setHits([])
    try {
      const r = await RecallApi.ask(q.trim())
      if (r.error) toast(r.error, 'error')
      setAnswer(r.answer || ''); setHits(r.hits || [])
    } catch (e: any) { toast('回忆失败：' + (e?.message || e), 'error') } finally { setBusy(false) }
  }
  const ready = stats && stats.snippets > 0
  return (
    <div className="panel !p-3.5 mb-4" data-slot="recall-panel">
      <div className="flex items-center gap-2">
        <Brain className="w-4 h-4 text-pi-accent" />
        <span className="text-[13px] font-semibold text-pi-text">跨会话回忆</span>
        <span className="text-[11px] text-pi-dim2">搜遍所有会话，带出处回答</span>
        {stats && <span className="ml-auto text-[10px] text-pi-dim2">{stats.snippets > 0 ? `${stats.sessions} 会话 · ${stats.snippets} 片段已索引` : '尚未建索引'}</span>}
      </div>
      <div className="flex gap-2 mt-2.5">
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && ask()}
          placeholder={ready ? '问过去：上次主题全景图怎么改的？…' : '先构建索引，再问过去'}
          aria-label="回忆搜索" className="flex-1 input-pi !py-1.5 text-[13px]" />
        {!ready
          ? <button className="btn-primary text-xs px-3 py-1.5 disabled:opacity-60" onClick={buildIndex} disabled={building}>{building ? '索引中…' : '构建索引'}</button>
          : <button className="btn-primary text-xs px-3 py-1.5 disabled:opacity-60" onClick={ask} disabled={busy || !q.trim()}>{busy ? '回忆中…' : '回忆'}</button>}
        {ready && onGenSums && (
          <button className="btn-ghost text-xs px-3 py-1.5 disabled:opacity-60" onClick={onGenSums} disabled={sumBusy} title="LLM 给尚未摘要的会话生成一句话摘要，每次 5 个">{sumBusy ? '摘要中…' : '生成摘要'}</button>
        )}
      </div>
      {ready && sums && (
        <div className="text-[10px] text-pi-dim2 mt-1 px-1">已摘要 <b className="text-pi-dim">{Object.values(sums).filter(s => s !== '(过短会话)').length}</b> 个会话，显示在下方会话名下</div>
      )}
      {answer && (
        <div className="mt-3 rounded-pi-md border border-pi-border-soft bg-pi-bg2/50 p-3">
          <div className="text-[12px] text-pi-dim whitespace-pre-wrap leading-relaxed">{answer}</div>
        </div>
      )}
      {hits.length > 0 && (
        <div className="mt-2 space-y-1.5">
          <div className="text-[10px] text-pi-dim2 px-1">命中片段（{hits.length}）</div>
          {hits.map((h: any, i: number) => (
            <div key={i} className="rounded-pi-md border border-pi-border-soft px-2.5 py-1.5 flex items-start gap-2">
              <span className={`text-[10px] px-1 py-0.5 rounded-pi-pill flex-shrink-0 mt-0.5 ${h.role === 'user' ? 'bg-pi-accent-soft text-pi-accent' : 'bg-pi-bg3 text-pi-dim2'}`}>{h.role === 'user' ? '问' : '答'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-pi-dim truncate">{h.text}</div>
                <div className="text-[10px] text-pi-dim2 mt-0.5 flex items-center gap-1.5">
                  <span className="truncate max-w-[240px]">{h.name || h.sid}</span>
                  {h.ts && <span>· {String(h.ts).slice(5, 10)}</span>}
                  {onOpenSession && <button className="text-pi-accent hover:underline flex-shrink-0" onClick={() => onOpenSession({ id: h.sid, name: h.name, cwd: '', sizeBytes: 0, health: 'ok', messageCount: null, mtime: null, seq: null, pinned: false, tags: [] })}>打开会话 →</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
