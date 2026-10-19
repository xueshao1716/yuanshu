// 设计委托面板（2026-10-19）
// 对标 Lovart 2.0 的 Arti：委托要能被看见——进度、额度、上次报告、试跑与启停都在这一个抽屉里。
import { useCallback, useEffect, useState } from 'react'
import { Play, Pause, Trash2, RefreshCw, Plus, FileText, X } from 'lucide-react'
import { getApiBase, getToken } from '../api'

type Issue = { level: string; code: string; message: string }
type Report = { at: string; ok: boolean; spent: number; cap: number; files: { name: string; url: string }[]; errors: { name: string; error: string }[]; issues: Issue[]; note: string }
type Commission = {
  id: string; title: string; goal: string; status: string; spent: number; cap: number
  everyMinutes: number; nextRunAt: number | null; lastReport: Report | null
  brief: { deliverables: string[]; requiredText: string[]; forbidden: string[]; ratios: Record<string, number> }
}

const STATUS_LABEL: Record<string, string> = {
  running: '进行中', paused: '已暂停', done: '已完成', capped: '额度用尽', failed: '失败', draft: '草稿',
}
const STATUS_TONE: Record<string, string> = {
  running: 'text-pi-success', paused: 'text-pi-warn', done: 'text-pi-text', capped: 'text-pi-red', failed: 'text-pi-red', draft: 'text-pi-dim',
}

const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...(init?.headers || {}) },
  })
  return res.json().catch(() => ({}))
}

export default function CommissionPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Commission[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ title: '', goal: '', deliverables: '', cap: 6, everyMinutes: 0 })

  const load = useCallback(async () => {
    try {
      const j = await api('/api/design-commissions')
      setItems(Array.isArray(j?.items) ? j.items : [])
      setError('')
    } catch { setError('委托列表读取失败') }
  }, [])

  useEffect(() => { void load() }, [load])

  const act = async (id: string, path: string, method = 'POST', label = '') => {
    setBusy(id + label)
    try {
      const j = await api(path, { method })
      if (j?.ok === false && j?.reason) setError(`没跑成：${j.reason === 'capped' ? '额度已用尽' : j.reason}`)
      else setError('')
      await load()
    } catch { setError('操作失败') } finally { setBusy('') }
  }

  const create = async () => {
    if (!form.title.trim()) { setError('先给委托起个名字'); return }
    setBusy('create')
    try {
      const j = await api('/api/design-commissions', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title.trim(),
          goal: form.goal.trim(),
          brief: { deliverables: form.deliverables.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean) },
          cap: Number(form.cap) || 0,
          everyMinutes: Number(form.everyMinutes) || 0,
        }),
      })
      if (j?.ok) { setShowForm(false); setForm({ title: '', goal: '', deliverables: '', cap: 6, everyMinutes: 0 }) } else setError(j?.error || '创建失败')
      await load()
    } catch { setError('创建失败') } finally { setBusy('') }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 sm:p-8" role="dialog" aria-label="设计委托">
      <div className="w-full max-w-[820px] max-h-[86vh] overflow-y-auto rounded-pi-md bg-pi-bg border border-pi-border-soft shadow-xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-pi-border-soft sticky top-0 bg-pi-bg z-10">
          <div>
            <h2 className="text-[14px] font-medium text-pi-text">设计委托</h2>
            <p className="text-[11px] text-pi-dim mt-0.5">交付件清单 · 一次出图 1 点 · 到额度自动熔断</p>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className="btn-tool !min-h-9" onClick={() => void load()} title="刷新"><RefreshCw className="w-3.5 h-3.5" /></button>
            <button type="button" className="btn-tool !min-h-9" onClick={() => setShowForm((v) => !v)}><Plus className="w-3.5 h-3.5" /><span className="hidden sm:inline">新建</span></button>
            <button type="button" className="btn-tool !min-h-9" onClick={onClose} title="关闭"><X className="w-3.5 h-3.5" /></button>
          </div>
        </header>

        {showForm && (
          <div className="p-4 border-b border-pi-border-soft space-y-2">
            <input className="pi-input w-full" placeholder="委托名，例如 双11 主视觉" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <textarea className="pi-input w-full min-h-[64px]" placeholder="目标与约束（会写进每张图的提示词）" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
            <input className="pi-input w-full" placeholder="交付件，用逗号分隔：主海报, 竖版, 方卡" value={form.deliverables} onChange={(e) => setForm({ ...form, deliverables: e.target.value })} />
            <div className="flex items-center gap-3 text-[12px] text-pi-dim">
              <label className="flex items-center gap-1.5">额度
                <input type="number" min={0} max={200} className="pi-input w-20" value={form.cap} onChange={(e) => setForm({ ...form, cap: Number(e.target.value) })} />
                点
              </label>
              <label className="flex items-center gap-1.5">周期
                <input type="number" min={0} step={15} className="pi-input w-20" value={form.everyMinutes} onChange={(e) => setForm({ ...form, everyMinutes: Number(e.target.value) })} />
                分钟（0=只跑一次）
              </label>
              <button type="button" className="btn-tool !min-h-9 ml-auto" disabled={busy === 'create'} onClick={() => void create()}>创建</button>
            </div>
          </div>
        )}

        {error && <p className="px-4 py-2 text-[12px] text-pi-red border-b border-pi-border-soft">{error}</p>}

        <ul className="divide-y divide-pi-border-soft">
          {items.length === 0 && <li className="px-4 py-6 text-[12px] text-pi-dim">还没有委托。点「新建」写清目标与交付件就能开一单。</li>}
          {items.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] text-pi-text truncate">{c.title}</span>
                    <span className={`text-[11px] ${STATUS_TONE[c.status] || 'text-pi-dim'}`}>{STATUS_LABEL[c.status] || c.status}</span>
                    <span className="text-[11px] text-pi-dim">·</span>
                    <span className="text-[11px] text-pi-dim">已用 {c.spent}/{c.cap} 点</span>
                    {c.everyMinutes > 0 && <span className="text-[11px] text-pi-dim">· 每 {c.everyMinutes} 分钟</span>}
                  </div>
                  {c.goal && <p className="text-[11px] text-pi-dim mt-1 line-clamp-2">{c.goal}</p>}
                  {c.brief?.deliverables?.length > 0 && (
                    <p className="text-[11px] text-pi-dim2 mt-1">交付：{c.brief.deliverables.join(' / ')}</p>
                  )}
                  {c.lastReport && (
                    <div className="mt-1.5 text-[11px]">
                      <span className={c.lastReport.ok ? 'text-pi-success' : 'text-pi-red'}>
                        {c.lastReport.ok ? '上次通过' : '上次有问题'}
                      </span>
                      <span className="text-pi-dim"> · {c.lastReport.files.length} 件交付 · {c.lastReport.note}</span>
                      {c.lastReport.errors.length > 0 && (
                        <p className="text-pi-red mt-0.5">{c.lastReport.errors.map((e) => `${e.name}（${e.error}）`).join('；')}</p>
                      )}
                      {c.lastReport.issues.length > 0 && (
                        <p className="text-pi-warn mt-0.5">{c.lastReport.issues.slice(0, 3).map((i) => i.message).join('；')}</p>
                      )}
                      {c.lastReport.files.length > 0 && (
                        <p className="text-pi-dim mt-0.5 truncate">{c.lastReport.files.map((f) => f.name).join(' / ')}</p>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button type="button" className="btn-tool !min-h-9" title="试跑一次" disabled={busy.startsWith(c.id)}
                    onClick={() => void act(c.id, `/api/design-commissions/${c.id}/run`, 'POST', 'run')}>
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="btn-tool !min-h-9" title={c.status === 'paused' ? '继续' : '暂停'} disabled={busy.startsWith(c.id)}
                    onClick={() => void act(c.id, `/api/design-commissions/${c.id}/${c.status === 'paused' ? 'resume' : 'pause'}`, 'POST', 'toggle')}>
                    <Pause className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="btn-tool !min-h-9" title="删除" disabled={busy.startsWith(c.id)}
                    onClick={() => void act(c.id, `/api/design-commissions/${c.id}`, 'DELETE', 'del')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <footer className="px-4 py-2 text-[11px] text-pi-dim border-t border-pi-border-soft flex items-center gap-1.5">
          <FileText className="w-3 h-3" /> 出图与巡检都由服务端完成；额度按“一次出图 1 点”计，到顶自动停。
        </footer>
      </div>
    </div>
  )
}
