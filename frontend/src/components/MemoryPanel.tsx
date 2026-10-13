import { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Search, Trash2, Pencil } from 'lucide-react'
import { api } from '../api'
import SectionHeader from './SectionHeader'

type MemoryItem = {
  memory_id: string
  memory_type: 'preference' | 'task_record' | 'fact'
  summary: string
  raw_content: string | null
  importance_score: number
  expire_at: number | null
  source: string
  status: 'active' | 'archived' | 'superseded'
  created_at: number
  updated_at: number
  access_count: number
}

const TYPE_LABEL: Record<string, string> = { preference: '偏好', task_record: '任务记录', fact: '事实' }
const STATUS_LABEL: Record<string, string> = { active: '活跃', archived: '已归档', superseded: '已取代' }
const VIEWS = [
  { key: '', label: '全部（按重要性）' },
  { key: 'recent', label: '最近记忆' },
  { key: 'important', label: '高重要性' },
  { key: 'expired', label: '已过期/归档' },
] as const
const PAGE_SIZE = 50

const emptyForm = { memory_type: 'fact', summary: '', raw_content: '', importance_score: 0.5, expire_at: '', status: 'active' }

export default function MemoryPanel() {
  const [view, setView] = useState<string>('')
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [data, setData] = useState<{ total: number; items: MemoryItem[] } | null>(null)
  const [editing, setEditing] = useState<null | { id?: string; form: typeof emptyForm }>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const fetchList = useCallback(async () => {
    const params = new URLSearchParams({ view, memory_type: type, q, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    setData(await api(`/api/memory?${params.toString()}`))
  }, [view, type, q, page])

  useEffect(() => { fetchList().catch(() => setData({ total: 0, items: [] })) }, [fetchList])

  async function save() {
    if (!editing) return
    setBusy(true); setMsg('')
    try {
      const body = JSON.stringify({
        memory_type: editing.form.memory_type,
        summary: editing.form.summary,
        raw_content: editing.form.raw_content || undefined,
        importance_score: Number(editing.form.importance_score),
        expire_at: editing.form.expire_at ? new Date(editing.form.expire_at).getTime() : null,
        status: editing.form.status,
      })
      if (editing.id) await api(`/api/memory/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body })
      else await api('/api/memory', { method: 'POST', body })
      setEditing(null); await fetchList()
    } catch (e: any) { setMsg(e?.message || '保存失败') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    setBusy(true)
    try { await api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' }); await fetchList() }
    finally { setBusy(false) }
  }

  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE))

  return (
    <div className="space-y-4">
      <SectionHeader
        title="记忆库"
        description="中长期记忆（偏好 / 任务记录 / 事实）的可视化管理：浏览、过滤、编辑、删除，无需写 SQL。"
        actions={
          <div className="flex gap-1.5">
            <button onClick={() => fetchList()} className="p-1.5 text-neutral-400 hover:text-blue-500 transition-colors" title="刷新"><RefreshCw size={14} /></button>
            <button onClick={() => setEditing({ form: { ...emptyForm } })} className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"><Plus size={13} />新增</button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map(v => (
          <button key={v.key} onClick={() => { setView(v.key); setPage(0) }}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${view === v.key ? 'border-blue-500 text-blue-500 bg-blue-500/5' : 'border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-800'}`}>
            {v.label}
          </button>
        ))}
        <select value={type} onChange={e => { setType(e.target.value); setPage(0) }}
          className="text-xs px-2 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300">
          <option value="">全部类型</option>
          <option value="preference">偏好</option>
          <option value="task_record">任务记录</option>
          <option value="fact">事实</option>
        </select>
        <div className="relative flex-1 min-w-[160px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
          <input value={q} onChange={e => { setQ(e.target.value); setPage(0) }} placeholder="搜索摘要/原文…"
            className="w-full text-xs pl-8 pr-3 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
        </div>
        {msg && <span className="text-xs text-pi-red">{msg}</span>}
      </div>

      <div className="rounded-xl border border-neutral-100 dark:border-neutral-700/50 divide-y divide-neutral-100 dark:divide-neutral-800">
        {(data?.items || []).map(it => (
          <div key={it.memory_id} className="px-3 py-2.5 flex items-start justify-between gap-3 hover:bg-neutral-50 dark:hover:bg-neutral-800/40 transition-colors">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-neutral-800 dark:text-neutral-200 break-words">{it.summary}</p>
              <p className="text-[11px] text-neutral-400 mt-0.5 flex flex-wrap gap-x-2">
                <span className="px-1.5 rounded bg-neutral-400/10 text-neutral-500">{TYPE_LABEL[it.memory_type]}</span>
                <span>重要性 {it.importance_score.toFixed(2)}</span>
                <span>{STATUS_LABEL[it.status]}</span>
                <span>{it.source}</span>
                <span>{new Date(it.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                {it.expire_at && <span className="text-amber-600">到期 {new Date(it.expire_at).toLocaleDateString('zh-CN')}</span>}
              </p>
            </div>
            <div className="flex gap-1 shrink-0">
              <button onClick={() => setEditing({
                id: it.memory_id,
                form: { memory_type: it.memory_type, summary: it.summary, raw_content: it.raw_content || '', importance_score: it.importance_score, expire_at: it.expire_at ? new Date(it.expire_at).toISOString().slice(0, 10) : '', status: it.status },
              })} title="编辑" className="p-1.5 text-neutral-400 hover:text-blue-500 transition-colors"><Pencil size={14} /></button>
              <button onClick={() => { if (confirm('删除这条记忆？')) remove(it.memory_id) }} disabled={busy} title="删除" className="p-1.5 text-neutral-400 hover:text-red-500 transition-colors disabled:opacity-40"><Trash2 size={14} /></button>
            </div>
          </div>
        ))}
        {data && data.items.length === 0 && <p className="text-xs text-neutral-400 py-3 px-1">当前视图没有记忆。</p>}
      </div>

      {(data?.total || 0) > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>共 {data?.total} 条 · 第 {page + 1}/{totalPages} 页</span>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="px-2.5 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">上一页</button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} className="px-2.5 py-1 rounded-lg border border-neutral-200 dark:border-neutral-700 disabled:opacity-40 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">下一页</button>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setEditing(null)}>
          <div className="w-[min(560px,92vw)] max-h-[88vh] overflow-auto rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 p-5 space-y-3"
            onClick={e => e.stopPropagation()}>
            <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{editing.id ? '编辑记忆' : '新增记忆'}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">类型</label>
                <select value={editing.form.memory_type} onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, memory_type: e.target.value } }))}
                  className="w-full text-xs px-2 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200">
                  <option value="preference">偏好</option>
                  <option value="task_record">任务记录</option>
                  <option value="fact">事实</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">状态</label>
                <select value={editing.form.status} onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, status: e.target.value } }))}
                  className="w-full text-xs px-2 py-1.5 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200">
                  <option value="active">活跃</option>
                  <option value="archived">已归档</option>
                  <option value="superseded">已取代</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">摘要（召回时注入的内容）</label>
              <textarea value={editing.form.summary} onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, summary: e.target.value } }))} rows={3} maxLength={2000}
                className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:ring-2 focus:ring-blue-500/30" />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">原始内容（可选，溯源用）</label>
              <textarea value={editing.form.raw_content} onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, raw_content: e.target.value } }))} rows={3}
                className="w-full text-xs px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 focus:outline-none focus:ring-2 focus:ring-blue-500/30 font-mono" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">重要性（0~1）</label>
                <input type="number" min={0} max={1} step={0.05} value={editing.form.importance_score}
                  onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, importance_score: Number(e.target.value) } }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200" />
              </div>
              <div>
                <label className="block text-xs text-neutral-500 mb-1">过期时间（留空=永不过期）</label>
                <input type="date" value={editing.form.expire_at} onChange={e => setEditing(s => s && ({ ...s, form: { ...s.form, expire_at: e.target.value } }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setEditing(null)} className="text-sm px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors">取消</button>
              <button onClick={save} disabled={busy || !editing.form.summary.trim()}
                className="text-sm px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">{busy ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
