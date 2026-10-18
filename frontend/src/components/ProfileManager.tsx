import { useMemo, useState } from 'react'
import { Check, Plus, RefreshCw, Trash2, UserRound, X } from 'lucide-react'
import { getApiBase, getToken, setApiBase, setToken } from '../api'
import { resolveSwitchTarget } from '../lib/switch-target.mjs'

// ── 账号管理（2026-10-12 伙伴要求）────────────────────────────────
// 每个人可能养了好多元枢（不同电脑/不同工作区），需要在各元枢之间切换。
// 档案 = { apiBase, token, label }，存在壳本地 localStorage（与 token 同级，不添新泄露面）。
// 切换 = 写入当前 apiBase/token → 刷新页面。退出登录仍保留在 sheet 底部（危险色）。
const PROFILES_KEY = 'yuanshu-profiles'
interface Profile { id: string; label: string; apiBase: string; token: string; savedAt: number }

const loadProfiles = (): Profile[] => {
  try {
    const raw = localStorage.getItem(PROFILES_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter(p => p && typeof p.apiBase === 'string') : []
  } catch { return [] }
}
const saveProfiles = (list: Profile[]) => { try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list.slice(0, 12))) } catch {} }
const hostOf = (url: string) => { try { return new URL(url).hostname || url } catch { return url || '本机' } }
const mask = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s || '')

export default function ProfileManager({ open, onClose, onLogout }: { open: boolean; onClose: () => void; onLogout: () => void }) {
  const [list, setList] = useState<Profile[]>(loadProfiles)
  const [label, setLabel] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const currentApiBase = getApiBase()
  const currentToken = getToken()
  const currentId = useMemo(() => `${currentApiBase}#${(currentToken || '').slice(0, 8)}`, [currentApiBase, currentToken])

  if (!open) return null
  const persist = (next: Profile[]) => { saveProfiles(next); setList(next) }

  const saveCurrent = () => {
    if (!currentApiBase && !currentToken) { setMsg('当前没有已登录的元枢，无档案可存'); return }
    const exists = list.find(p => p.id === currentId)
    const next = exists
      ? list.map(p => p.id === currentId ? { ...p, label: label || hostOf(currentApiBase), token: currentToken, savedAt: Date.now() } : p)
      : [{ id: currentId, label: label || hostOf(currentApiBase) || '本机', apiBase: currentApiBase, token: currentToken || '', savedAt: Date.now() }, ...list]
    persist(next); setLabel(''); setMsg(exists ? '已更新这份档案' : `已保存：${currentApiBase ? hostOf(currentApiBase) : '本机'}`)
  }

  const addManual = () => {
    const url = window.prompt('元枢服务器地址（http://192.168.x.x:8787 或公网域名）：')
    if (!url) return
    const base = url.trim().replace(/\/+$/, '')
    const token = window.prompt('访问令牌（就是那台元枢的）:') || ''
    const id = `${base}#${(token || '').slice(0, 8)}`
    if (list.some(p => p.id === id)) { setMsg('这个组合已经在档案里'); return }
    const profile: Profile = { id, label: hostOf(base), apiBase: base, token, savedAt: Date.now() }
    persist([profile, ...list])
    // 加完就切过去——否则"新账号"只是列表里多一条，地址并不会变（2026-10-18 修）。
    setMsg(`已加入 ${hostOf(base)}，正在切换…`)
    switchTo(profile)
  }

  const switchTo = (p: Profile) => {
    setBusy(true)
    try {
      // 2026-10-18：切到"别的元枢"必须真的跳转地址。原来只写 localStorage 再 reload，
      // 地址栏不变、页面仍由当前源提供 → 对远程实例等于没切换。
      const target = resolveSwitchTarget({ apiBase: p.apiBase, token: p.token, currentHref: window.location.href })
      if (target.kind === 'navigate') {
        setMsg(target.tokenInQuery
          ? `正在跳转到 ${hostOf(p.apiBase)}（已带上令牌）…`
          : `正在跳转到 ${hostOf(p.apiBase)}；那边的令牌首次需要输入一次，之后由该地址自己记住。`)
        window.location.assign(target.url)
        return
      }
      if (p.token) setToken(p.token)
      setApiBase(p.apiBase)
      setMsg(`已切换到 ${hostOf(p.apiBase)}，页面即将刷新…`)
      setTimeout(() => { window.location.reload() }, 400)
    } finally { setTimeout(() => setBusy(false), 600) }
  }

  const remove = (p: Profile) => { if (!window.confirm(`删除档案 ${p.label}（${hostOf(p.apiBase)}）？只删记录，不动元枢本身`)) return; persist(list.filter(x => x.id !== p.id)); setMsg('已删除') }

  return (
    <div className="profile-mask" onClick={e => { if (e.target === e.currentTarget) onClose() }} role="presentation">
      <section className="profile-sheet" role="dialog" aria-modal="true" aria-label="账号管理">
        <header className="flex items-center justify-between px-4 py-3 border-b border-pi-border-soft">
          <h2 className="text-sm font-semibold text-pi-text inline-flex items-center gap-2"><UserRound className="w-4 h-4" />账号管理 · 多元枢切换</h2>
          <button type="button" className="btn-tool !px-2" onClick={onClose} aria-label="关闭账号管理"><X className="w-4 h-4" /></button>
        </header>

        <div className="px-4 py-3 space-y-3 overflow-y-auto">
          <div className="rounded-pi-md border border-pi-border-soft p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] text-pi-dim">当前登录</span>
              {currentToken && <span className="text-[11px] font-mono text-pi-dim2">{mask(currentToken)}</span>}
            </div>
            <div className="text-sm text-pi-text break-all">{currentApiBase || '本机服务（未填写远程地址）'}</div>
            <div className="flex gap-2">
              <input aria-label="档案备注" className="input-pi !py-1.5 text-xs flex-1 min-w-0" placeholder="备注（如：客厅工位 / 妹妹的）" value={label} onChange={e => setLabel(e.target.value)} />
              <button type="button" className="btn-primary text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5" onClick={saveCurrent}>
                <Check className="w-3.5 h-3.5" />存为档案
              </button>
            </div>
          </div>

          {list.length > 0 && (
            <ul className="space-y-2">
              {list.map(p => {
                const isCurrent = p.id === currentId
                return (
                  <li key={p.id} className={`rounded-pi-md border p-3 ${isCurrent ? 'border-pi-accent/60 bg-pi-accent/5' : 'border-pi-border-soft'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[13px] text-pi-text font-medium">{p.label}{isCurrent && <span className="text-[10px] ml-2 px-1.5 py-0.5 rounded-pi-sm bg-pi-accent/15 text-pi-accent">当前</span>}</div>
                        <div className="text-[11px] text-pi-dim2 truncate">{p.apiBase || '本机服务'}{p.token ? ` · ${mask(p.token)}` : ''}</div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button type="button" disabled={isCurrent || busy} className="btn-primary text-[11px] !px-2.5 !py-1 inline-flex items-center gap-1 disabled:opacity-50" onClick={() => void switchTo(p)}>
                          <RefreshCw className="w-3 h-3" />切换
                        </button>
                        <button type="button" className="btn-tool text-[11px] !px-2 !py-1 text-pi-red" aria-label={`删除档案 ${p.label}`} onClick={() => remove(p)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          <button type="button" className="btn-tool text-xs !px-3 !py-1.5 inline-flex items-center gap-1.5" onClick={addManual}>
            <Plus className="w-3.5 h-3.5" />手动加入别的元枢
          </button>
          {msg && <p role="status" className="text-[12px] text-pi-dim">{msg}</p>}

          <div className="my-2 border-t border-pi-border-soft" />
          <button type="button" className="w-full justify-start gap-2 rounded-pi-md px-3 py-2 text-xs text-pi-red hover:bg-pi-bg3 inline-flex items-center" onClick={() => { onClose(); onLogout() }}>
            <X className="w-4 h-4" strokeWidth={1.8} />退出当前元枢登录
          </button>
        </div>
      </section>
    </div>
  )
}
