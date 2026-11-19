// ══════════════════════════════════════════════════════════
// ModelDefaultsCard —— 模型中心「默认设置」（2026-11-19）
// 默认模型 / 兜底顺序 / 每日 token 预算。以前只能改文件，这里改完立即生效。
// ══════════════════════════════════════════════════════════
import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { KeysApi, type ModelDefaults } from '../../api'
import type { Model } from '../../types'
import { effectiveCapabilities } from '../../../../shared/model-capabilities.mjs'
import { toast } from '../shell/Toast'

const keyOf = (m: Model) => `${m.provider}/${m.id}`
const fmtTokens = (n: number) => n >= 1e8 ? `${+(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${+(n / 1e4).toFixed(1)} 万` : String(n)

export default function ModelDefaultsCard({ models }: { models: Model[] }) {
  const [d, setD] = useState<ModelDefaults | null>(null)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState('')
  const [budgetWan, setBudgetWan] = useState('')

  useEffect(() => {
    KeysApi.defaults().then(r => { setD(r); setBudgetWan(String(r.budget.dailyTokens / 1e4)) }).catch(() => {})
  }, [])

  const textModels = models.filter(m => effectiveCapabilities(m).chat !== false && !/image|video|tts|music|embed/i.test(m.id))
  const label = (key: string) => { const m = models.find(x => keyOf(x) === key); return m ? `${m.name} · ${m.provider}` : `${key}（已不在列表）` }

  const save = async (patch: Parameters<typeof KeysApi.saveDefaults>[0], ok: string) => {
    setBusy(true)
    try {
      const r = await KeysApi.saveDefaults(patch)
      setD(r); setBudgetWan(String(r.budget.dailyTokens / 1e4))
      toast(ok, 'ok')
    } catch (e: any) { toast(String(e?.message || e), 'error') }
    finally { setBusy(false) }
  }

  if (!d) return null
  const fb = d.fallbacks
  const move = (i: number, dir: -1 | 1) => {
    const next = [...fb]; const j = i + dir
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    void save({ fallbacks: next }, '兜底顺序已更新')
  }
  const pct = d.budget.dailyTokens ? Math.min(100, Math.round(d.budget.usedToday / d.budget.dailyTokens * 100)) : 0

  return (
    <section className="panel !p-4 sm:!p-5 mb-4 space-y-5" aria-labelledby="model-defaults-title">
      <h2 id="model-defaults-title" className="text-[14px] font-semibold text-pi-text">默认设置</h2>

      <div className="space-y-1.5">
        <div className="text-[13px] text-pi-text">默认模型</div>
        <p className="text-[12px] text-pi-dim2">新会话和后台任务（定时任务、复盘、子代理）默认用它；会话里手动切过的以会话为准。</p>
        <select
          aria-label="默认模型"
          disabled={busy}
          value={d.defaultModel}
          onChange={e => void save({ defaultModel: e.target.value }, '默认模型已更换，立即生效')}
          className="w-full sm:w-96 px-2 py-1.5 rounded bg-pi-bg border border-pi-border text-pi-text text-[13px]"
        >
          {!textModels.some(m => keyOf(m) === d.defaultModel) && <option value={d.defaultModel}>{label(d.defaultModel)}</option>}
          {textModels.map(m => <option key={keyOf(m)} value={keyOf(m)}>{m.name} · {m.provider}</option>)}
        </select>
      </div>

      <div className="space-y-1.5">
        <div className="text-[13px] text-pi-text">兜底模型（按顺序）</div>
        <p className="text-[12px] text-pi-dim2">当前模型欠费、限流或出错，以及超出每日预算时，从上往下换第一个可用的。没排的话用系统内置顺序（Agnes 3.0 Flash 在前）。</p>
        <ol className="space-y-1">
          {fb.map((k, i) => (
            <li key={k} className="flex items-center gap-2 text-[13px]">
              <span className="w-5 text-pi-dim2 text-right">{i + 1}.</span>
              <span className="flex-1 min-w-0 truncate text-pi-text">{label(k)}</span>
              <button className="btn-tool" aria-label="上移" disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp className="w-3.5 h-3.5" /></button>
              <button className="btn-tool" aria-label="下移" disabled={busy || i === fb.length - 1} onClick={() => move(i, 1)}><ArrowDown className="w-3.5 h-3.5" /></button>
              <button className="btn-tool" aria-label="移除" disabled={busy} onClick={() => void save({ fallbacks: fb.filter(x => x !== k) }, '已移除')}><X className="w-3.5 h-3.5" /></button>
            </li>
          ))}
          {!fb.length && <li className="text-[12px] text-pi-dim2">（未设置，使用内置顺序）</li>}
        </ol>
        {fb.length < 10 && (
          <div className="flex items-center gap-2">
            <select aria-label="添加兜底模型" value={adding} onChange={e => setAdding(e.target.value)}
              className="w-full sm:w-96 px-2 py-1.5 rounded bg-pi-bg border border-pi-border text-pi-text text-[13px]">
              <option value="">选择要加入的模型…</option>
              {textModels.filter(m => !fb.includes(keyOf(m))).map(m => <option key={keyOf(m)} value={keyOf(m)}>{m.name} · {m.provider}</option>)}
            </select>
            <button className="btn-tool flex items-center gap-1" disabled={busy || !adding}
              onClick={() => { const k = adding; setAdding(''); void save({ fallbacks: [...fb, k] }, '已加入兜底') }}>
              <Plus className="w-3.5 h-3.5" />加入
            </button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="text-[13px] text-pi-text">每日 token 预算</div>
        <p className="text-[12px] text-pi-dim2">今天已用 {fmtTokens(d.budget.usedToday)} / {fmtTokens(d.budget.dailyTokens)}（{pct}%）。超出后{d.budget.downgrade ? '自动换到兜底里更便宜的模型' : '只提醒，不换模型'}。</p>
        <div className="h-1.5 rounded-full bg-pi-border overflow-hidden w-full sm:w-96">
          <div className="h-full" style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--pi-danger)' : 'var(--pi-accent)' }} />
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-pi-dim">
          <label className="flex items-center gap-2">
            每天
            <input type="number" min={10} step={100} aria-label="每日预算（万 token）" value={budgetWan} disabled={busy}
              onChange={e => setBudgetWan(e.target.value)}
              className="w-28 px-2 py-1 rounded bg-pi-bg border border-pi-border text-pi-text text-xs" />
            万 token
          </label>
          <button className="btn-tool" disabled={busy || Number(budgetWan) * 1e4 === d.budget.dailyTokens}
            onClick={() => void save({ dailyTokens: Math.round(Number(budgetWan) * 1e4) }, '每日预算已更新')}>保存</button>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={d.budget.downgrade} disabled={busy}
              onChange={e => void save({ downgrade: e.target.checked }, e.target.checked ? '超预算后会自动换便宜模型' : '超预算后只提醒')} />
            超预算自动换便宜模型
          </label>
        </div>
      </div>
    </section>
  )
}
