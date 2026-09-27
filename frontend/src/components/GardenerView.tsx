import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Check, EyeOff, Scissors, AlertTriangle, RefreshCw, Sprout, Archive, RotateCcw, Handshake, Moon, Target } from 'lucide-react'
import useSWR from 'swr'
import { MemoryApi, PromiseApi, GoalApi, type PromisePending } from '../api'
import EmptyState from '../components/EmptyState'

// ── 记忆园丁视图（08-26 重做）：明细可见 + 人工核对按钮 ──
// 原则不变：园丁只报告；「标记已核对」只记核对结论不动记忆文件；
// 「去重」是显式人工动作——先落 .bak 备份再重写日志（每组保留最新一条）。
//
// 09-14 补两块台前（此前只有引擎侧、没有入口）：
//   · 记忆快照：列表 + 回退。快照过去只写不读（98.7MB 攒着却一份都回退不了）。
//   · 待兑现承诺：小语自己许下的「明天/回头/下次」。结清只能人工给结论。

type Kind = 'dup' | 'stale'

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="stat-card !p-3.5">
      <div className="text-[11px] text-pi-dim2">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${warn && value > 0 ? 'text-pi-warning' : ''}`}>{value}</div>
    </div>
  )
}

const SNAP_REASON: Record<string, string> = {
  manual: '手动',
  auto: '每 20 轮自动',
  'archive-before': '归档状态节前',
  'distill-before': '提炼偏好前',
  'pre-restore': '回退前自保',
}
// 旧版快照的 reason 带毫秒后缀（archive-before-1789395260010），归一化后再查表
const snapReason = (r: string) => {
  const key = String(r || '').replace(/-\d{6,}$/, '')
  return SNAP_REASON[key] || key || '未知来源'
}

function SnapshotSection({ onRestored }: { onRestored: () => void }) {
  const { data, mutate, isLoading } = useSWR('memory-snapshots', () => MemoryApi.snapshots(), { dedupingInterval: 15000 })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const items = data?.items || []
  const totalMB = items.reduce((n, x) => n + (x.bytes || 0), 0) / 1048576

  const restore = async (id: string, reason: string) => {
    if (!confirm(`回退到快照 ${id}（${snapReason(reason)}）？\n\n当前的 记忆.md / 记忆日志.md / 纠正记忆 / 关系记忆 会被覆盖。\n回退前会自动再存一份现状，可再退回来。\n\n确定执行？`)) return
    setBusy(id); setMsg('')
    try {
      const r = await MemoryApi.restoreSnapshot(id)
      if (r.ok) { setMsg(`已回退到 ${r.id}（${snapReason(String(r.reason))}）`); await mutate(); onRestored() }
      else setMsg(`回退失败：${r.error || r.reason || '未知原因'}`)
    } catch (e: any) { setMsg('回退失败：' + (e?.message || e)) } finally { setBusy('') }
  }

  return (
    <div>
      <div className="flex items-center mb-2">
        <h3 className="text-[13px] font-semibold text-pi-text inline-flex items-center gap-1.5"><Archive className="w-3.5 h-3.5" />记忆快照</h3>
        <span className="ml-auto text-[11px] text-pi-dim2">
          {isLoading ? '读取中…' : `${data?.total ?? 0} 份 · ${totalMB.toFixed(1)}MB（上限 30 份 / 12MB）`}
        </span>
      </div>
      {msg && <div className="panel !p-2.5 text-xs text-pi-accent mb-2 flex items-center gap-2"><Check className="w-3.5 h-3.5 flex-shrink-0" />{msg}</div>}
      {items.length === 0 ? (
        <p className="text-xs text-pi-dim2 px-1">{isLoading ? '正在读取快照…' : '还没有快照。记忆真正发生变化（归档状态节等）时会自动存一份。'}</p>
      ) : (
        <div className="space-y-1.5">
          {items.slice(0, 8).map(s => (
            <div key={s.id} className="panel !p-2.5 flex items-center gap-2.5">
              <span className="font-mono text-[11px] text-pi-dim2 flex-shrink-0">{s.id}</span>
              <span className="text-[11px] text-pi-dim truncate">{snapReason(s.reason)}</span>
              <span className="ml-auto text-[10px] text-pi-dim2 flex-shrink-0">{Math.round((s.bytes || 0) / 1024)}KB</span>
              <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1 flex-shrink-0"
                disabled={busy === s.id} onClick={() => restore(s.id, s.reason)} title="把记忆回退到这份快照">
                <RotateCcw className="w-3 h-3" />{busy === s.id ? '回退中…' : '回退'}
              </button>
            </div>
          ))}
          {items.length > 8 && <p className="text-[10px] text-pi-dim2 px-1">仅列出最近 8 份，共 {data?.total ?? items.length} 份。</p>}
        </div>
      )}
    </div>
  )
}

function GoalSection() {
  const { data, mutate, isLoading } = useSWR('goals', () => GoalApi.list(), { dedupingInterval: 15000 })
  const [busy, setBusy] = useState('')
  const [draft, setDraft] = useState('')
  const [msg, setMsg] = useState('')
  const goals = data?.goals || []
  const active = data?.active || null
  const open = goals.filter(g => g.status === 'paused' || g.status === 'active')

  const act = async (id: string, action: 'arm' | 'pause' | 'complete' | 'block') => {
    let extra: { evidence?: string; reason?: string } = {}
    if (action === 'complete') {
      extra.evidence = prompt('标记「已完成」：写下可核查的证据（文件路径 / 测试名 / 提交号）。留空会记为「无证据」。') || ''
    } else if (action === 'block') {
      const r = prompt('标记「受阻」：卡在哪里？') ; if (r === null) return; extra.reason = r
    }
    setBusy(id + action); setMsg('')
    try {
      const r = await GoalApi.action(id, action, extra)
      if (!r.ok) setMsg(r.reason || '操作被拒')
      await mutate()
    } catch (e: any) { setMsg('操作失败：' + (e?.message || e)) } finally { setBusy('') }
  }
  const create = async () => {
    const text = draft.trim(); if (text.length < 4) return
    setBusy('create'); setMsg('')
    try {
      const r = await GoalApi.create(text)
      if (!r.ok) setMsg(r.reason || '新建失败'); else setDraft('')
      await mutate()
    } catch (e: any) { setMsg('新建失败：' + (e?.message || e)) } finally { setBusy('') }
  }

  return (
    <div>
      <div className="flex items-center mb-2">
        <h3 className="text-[13px] font-semibold text-pi-text inline-flex items-center gap-1.5"><Target className="w-3.5 h-3.5" />跨轮目标</h3>
        <span className="ml-auto text-[11px] text-pi-dim2">
          {isLoading ? '读取中…' : active ? `进行中：第 ${active.round}/${active.maxRounds} 轮` : open.length ? `${open.length} 个未武装` : '没有目标'}
        </span>
      </div>
      <p className="text-[11px] text-pi-dim2 px-1 mb-2">
        一个目标跨多轮自己往下走。引擎侧有三重闸门：到回合上限自动停、同一轮不重复驱动、出错立刻解除。
        <span className="text-pi-text">武装与结清只有你能做</span>——它自己宣布完成不算数，重启后也会回到未武装态。
      </p>
      {msg && <div className="panel !p-2.5 text-xs text-pi-warning mb-2 flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{msg}</div>}
      <div className="flex gap-2 mb-2">
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="要它跨轮推进的目标（至少 4 个字）"
          className="flex-1 min-w-0 input !py-1.5 text-[12px]" onKeyDown={e => { if (e.key === 'Enter') create() }} />
        <button className="btn-tool text-[11px] !px-2.5 !py-1.5 flex-shrink-0" disabled={busy === 'create' || draft.trim().length < 4} onClick={create}>新建</button>
      </div>
      {goals.length === 0 ? (
        <p className="text-xs text-pi-dim2 px-1">{isLoading ? '正在读取…' : '还没有目标。新建后要先点「武装」才会开始推进。'}</p>
      ) : (
        <div className="space-y-2">
          {goals.slice(0, 6).map(g => (
            <div key={g.id} className={`panel !p-3 flex items-start gap-2.5 ${g.status === 'complete' ? 'opacity-60' : ''}`}>
              <span className={`mt-0.5 flex-shrink-0 ${g.status === 'active' ? 'text-pi-accent' : g.status === 'blocked' ? 'text-pi-warning' : 'text-pi-dim2'}`}>
                {g.status === 'blocked' ? <AlertTriangle className="w-4 h-4" strokeWidth={1.8} /> : <Target className="w-4 h-4" strokeWidth={1.8} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-pi-text break-all">{g.objective}</div>
                <div className="text-[10px] text-pi-dim2 mt-0.5">
                  {g.status === 'active' ? `进行中 · 第 ${g.round}/${g.maxRounds} 轮` : g.status === 'paused' ? '未武装' : g.status === 'complete' ? '已完成' : '受阻'}
                  {g.evidence ? ` · 证据：${g.evidence}` : g.status === 'complete' ? ' · 无证据' : ''}
                  {g.blockedReason ? ` · ${g.blockedReason}` : ''}
                </div>
              </div>
              <span className="flex gap-1.5 flex-shrink-0">
                {(g.status === 'paused') && <button className="btn-tool text-[11px] !px-2 !py-1" disabled={busy === g.id + 'arm'} onClick={() => act(g.id, 'arm')}>武装</button>}
                {g.status === 'active' && <button className="btn-tool text-[11px] !px-2 !py-1" disabled={busy === g.id + 'pause'} onClick={() => act(g.id, 'pause')}>暂停</button>}
                {(g.status === 'active' || g.status === 'paused') && <>
                  <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1" disabled={busy === g.id + 'complete'} onClick={() => act(g.id, 'complete')}><Check className="w-3 h-3" />已完成</button>
                  <button className="btn-tool text-[11px] !px-2 !py-1" disabled={busy === g.id + 'block'} onClick={() => act(g.id, 'block')}>受阻</button>
                </>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function PromiseSection() {
  const { data, mutate, isLoading } = useSWR('promises', () => PromiseApi.list(), { dedupingInterval: 15000 })
  const [busy, setBusy] = useState('')
  const [showClosed, setShowClosed] = useState(false)
  const [msg, setMsg] = useState('')
  const pending = data?.pending || []
  const closed = data?.closed || []
  const overdue = pending.filter(p => p.overdue).length

  const settle = async (p: PromisePending, status: 'kept' | 'dropped') => {
    let evidence = ''
    if (status === 'kept') {
      evidence = prompt(`标记「已兑现」：${p.text}\n\n写下可核查的证据（文件路径 / 测试名 / 提交号）。留空会记为「无证据」。`) || ''
    } else if (!confirm(`把「${p.text}」标记为不再需要？`)) return
    setBusy(p.id); setMsg('')
    try {
      const r = await PromiseApi.close(p.id, status, evidence)
      if (!r?.ok) { setMsg(`销账失败：${r?.reason || '后台未确认写入'}`); return }
      // 结清后强制从服务端重读，避免只改本地列表或命中旧缓存。
      await mutate(undefined, { revalidate: true })
    } catch (e: any) { setMsg('销账失败：' + (e?.message || e)) } finally { setBusy('') }
  }

  return (
    <div>
      <div className="flex items-center mb-2">
        <h3 className="text-[13px] font-semibold text-pi-text inline-flex items-center gap-1.5"><Handshake className="w-3.5 h-3.5" />待兑现承诺</h3>
        <span className="ml-auto text-[11px] text-pi-dim2">
          {isLoading ? '读取中…' : pending.length ? `${pending.length} 条挂着${overdue ? ` · ${overdue} 条逾期` : ''}` : '没有挂着的事'}
        </span>
      </div>
      <p className="text-[11px] text-pi-dim2 px-1 mb-2">
        小语自己说过的「明天 / 回头 / 下次…」。下一轮对话会提醒它主动交代；结清只能由你给结论——系统不会自动判定「大概做了吧」。
      </p>
      {msg && <div className="panel !p-2.5 text-xs text-pi-warning mb-2">{msg}</div>}
      {pending.length === 0 ? (
        <EmptyState icon={Handshake} title={isLoading ? '正在读取…' : '没有待兑现的承诺'} hint={isLoading ? undefined : '它下次说「回头给你」时，会出现在这里'} />
      ) : (
        <div className="space-y-2">
          {pending.map(p => (
            <div key={p.id} className="panel !p-3 flex items-start gap-2.5">
              <span className={`mt-0.5 flex-shrink-0 ${p.overdue ? 'text-pi-warning' : 'text-pi-dim2'}`}>
                {p.overdue ? <AlertTriangle className="w-4 h-4" strokeWidth={1.8} /> : <Handshake className="w-4 h-4" strokeWidth={1.8} />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-pi-text break-all">{p.text}</div>
                <div className="text-[10px] text-pi-dim2 mt-0.5">
                  {p.agePhrase}{p.due ? ` · 约定 ${String(p.due).slice(0, 10)}` : ''}{p.overdue ? ' · 已逾期' : ''}
                </div>
              </div>
              <span className="flex gap-1.5 flex-shrink-0">
                <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1" disabled={busy === p.id}
                  onClick={() => settle(p, 'kept')} title="给出可核查的证据，结清这条账"><Check className="w-3 h-3" />已兑现</button>
                <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1 hover:!text-pi-red" disabled={busy === p.id}
                  onClick={() => settle(p, 'dropped')} title="不打算做了，销账">不再需要</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {closed.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setShowClosed(v => !v)} className="text-[11px] text-pi-dim2 hover:text-pi-text inline-flex items-center gap-1">
            {showClosed ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}已结清 {closed.length} 条
          </button>
          {showClosed && (
            <div className="mt-1.5 space-y-1">
              {closed.map(c => (
                <div key={c.id} className="flex items-start gap-2 text-[11px] px-1 opacity-70">
                  <span className={`flex-shrink-0 ${c.status === 'kept' ? 'text-pi-success' : 'text-pi-dim2'}`}>{c.status === 'kept' ? '✓' : '—'}</span>
                  <span className="text-pi-dim break-all">{c.text}</span>
                  <span className="ml-auto text-[10px] text-pi-dim2 flex-shrink-0">{c.evidence ? c.evidence.slice(0, 40) : '无证据'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function GardenerView() {
  const { data, isLoading, mutate } = useSWR('memory-gardener-report', () => MemoryApi.report(), {
    dedupingInterval: 15000,
  })
  const [showReviewed, setShowReviewed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const rep = (data as any)?.report || {}
  const reviewed = new Set<string>((rep.reviewed || []).map((x: any) => `${x.kind}:${x.key}`))
  const dups = rep.duplicates || []
  const staleSections = rep.staleSections?.sections || []
  const dupEntries = dups.reduce((n: number, g: any) => n + g.count, 0)
  // 注意：rhythm 在响应顶层（与 report 平级），不在 report 里面
  const rhythm = (data as any)?.rhythm || null
  const rhythmMax = rhythm ? Math.max(1, ...(rhythm.hours || [1])) : 1
  const pad2 = (n: number) => String(n).padStart(2, '0')

  const isDismissed = (kind: Kind, key: string) => reviewed.has(`${kind}:${key}`)
  const visibleDups = showReviewed ? dups : dups.filter((g: any) => !isDismissed('dup', g.key))
  const visibleStale = showReviewed ? staleSections : staleSections.filter((s: any) => !isDismissed('stale', s.date))

  const mark = async (kind: Kind, key: string) => {
    try { await MemoryApi.markReviewed(kind, key); await mutate() } catch {}
  }
  const dedupe = async () => {
    if (!confirm(`一键去重：每组重复保留最新一条，其余删除。\n原日志会先备份为 .bak 文件，可手动恢复。\n\n确定执行？`)) return
    setBusy('dedupe'); setMsg('')
    try {
      const r = await MemoryApi.dedupe()
      setMsg(r.removed > 0 ? `已去除 ${r.removed} 条重复，原日志备份：${r.backup?.split(/[\\/]/).pop()}` : '没有需要去除的重复')
      await mutate()
    } catch (e: any) { setMsg('去重失败：' + (e?.message || e)) } finally { setBusy('') }
  }

  if (isLoading) return <div className="py-10 text-center text-pi-dim2 text-sm">扫描记忆中…</div>

  return (
    <div className="space-y-4">
      {/* 统计 */}
      <div className="grid grid-cols-3 gap-2.5">
        <Stat label="记忆日志条目" value={rep.totalEntries || 0} />
        <Stat label={`疑似重复（${dups.length} 组）`} value={dupEntries} warn />
        <Stat label="过时「状态」节" value={rep.staleSections?.staleCount || 0} warn />
      </div>

      {msg && <div className="panel !p-3 text-xs text-pi-accent flex items-center gap-2"><Check className="w-4 h-4 flex-shrink-0" />{msg}</div>}

      {/* 疑似重复组：展开看每条内容 */}
      <div>
        <div className="flex items-center mb-2">
          <h3 className="text-[13px] font-semibold text-pi-text">疑似重复 / 流水账</h3>
          <span className="ml-auto flex items-center gap-2">
            <button onClick={() => setShowReviewed(v => !v)}
              className="text-[11px] text-pi-dim2 hover:text-pi-text inline-flex items-center gap-1">
              <EyeOff className="w-3 h-3" />{showReviewed ? '隐藏已核对' : '显示已核对'}
            </button>
          </span>
        </div>
        {visibleDups.length === 0 ? (
          <EmptyState icon={Sprout} title={dups.length ? '本组筛选下无待核对的重复' : '没发现重复/流水账条目'} hint={dups.length ? undefined : '同要点反复出现时园丁会在这里提示'} />
        ) : (
          <div className="space-y-2">
            {visibleDups.map((g: any) => {
              const dismissed = isDismissed('dup', g.key)
              const open = expanded === g.key
              return (
                <div key={g.key} className={`panel !p-3 ${dismissed ? 'opacity-55' : ''}`}>
                  <button className="w-full flex items-center gap-2 cursor-pointer text-left" aria-expanded={open} onClick={() => setExpanded(open ? null : g.key)}>
                    {open ? <ChevronDown className="w-4 h-4 text-pi-dim2" /> : <ChevronRight className="w-4 h-4 text-pi-dim2" />}
                    <AlertTriangle className="w-4 h-4 text-pi-warning flex-shrink-0" strokeWidth={1.8} />
                    <span className="text-[12px] text-pi-text font-medium truncate">{g.key}</span>
                    <span className="text-[10px] px-1.5 py-px rounded-pi-pill bg-pi-warning/15 text-pi-warning flex-shrink-0">{g.count} 条</span>
                    <span className="ml-auto flex gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      {!dismissed && (
                        <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1" title="核对完毕，从待办中隐藏"
                          onClick={() => mark('dup', g.key)}><EyeOff className="w-3 h-3" />已核对</button>
                      )}
                      <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1 hover:!text-pi-red" title="删除该组较旧条目，保留最新一条"
                        onClick={() => dedupe()}><Scissors className="w-3 h-3" />去重</button>
                    </span>
                  </button>
                  {open && (
                    <div className="mt-2 space-y-1.5 border-t border-pi-border-soft pt-2">
                      {(g.previews || []).map((pv: string, i: number) => (
                        <div key={i} className="flex gap-2 text-[11px]">
                          <span className="font-mono text-pi-dim2 flex-shrink-0">{(g.dates || [])[i] || '?'}</span>
                          <span className="text-pi-dim break-all">{pv}</span>
                        </div>
                      ))}
                      <div className="text-[10px] text-pi-dim2 pt-1">点「去重」将删除此组中除最新外的 {g.count - 1} 条（先自动备份）</div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 过时状态节明细 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[13px] font-semibold text-pi-text">过时的「当前状态」节</h3>
          {rep.staleSections?.latestDate && (
            <button className="text-[11px] text-pi-dim2 hover:text-pi-text inline-flex items-center gap-1" onClick={() => mutate()}>
              <RefreshCw className="w-3 h-3" />重新扫描
            </button>
          )}
        </div>
        {visibleStale.length === 0 ? (
          <p className="text-xs text-pi-dim2 px-1">当前状态节都在 {rep.staleSections?.latestDate ? `最新一版（${rep.staleSections.latestDate}）7 天内` : '新鲜状态'}，无需处理。</p>
        ) : (
          <div className="space-y-2">
            {visibleStale.map((s: any) => {
              const dismissed = isDismissed('stale', s.date)
              return (
                <div key={s.date} className={`panel !p-3 flex items-start gap-2.5 ${dismissed ? 'opacity-55' : ''}`}>
                  <AlertTriangle className="w-4 h-4 text-pi-warning flex-shrink-0 mt-0.5" strokeWidth={1.8} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-pi-text">当前状态（{s.date}）{s.title && <span className="text-pi-dim2 ml-1">{s.title}</span>}</div>
                    <div className="text-[11px] text-pi-dim2 mt-0.5 break-all">{s.preview || '（无正文预览）'}</div>
                  </div>
                  {!dismissed && (
                    <button className="btn-tool text-[11px] !px-2 !py-1 inline-flex items-center gap-1 flex-shrink-0" title="核对完毕，从待办中隐藏"
                      onClick={() => mark('stale', s.date)}><EyeOff className="w-3 h-3" />已核对</button>
                  )}
                </div>
              )
            })}
            <p className="text-[10px] text-pi-dim2 px-1">处理方式建议：把仍有效的信息合并进最新的「当前状态」节后，直接编辑 记忆.md 删除旧节。</p>
          </div>
        )}
      </div>

      {/* 观测到的作息：由 activity-rhythm 从真实时间戳读出；观测不到（样本不足）就不显示，不编 */}
      {rhythm && (
        <div className="panel !p-3">
          <h3 className="text-[13px] font-semibold text-pi-text mb-1.5 inline-flex items-center gap-1.5"><Moon className="w-3.5 h-3.5" />观测到的作息</h3>
          <p className="text-[12px] text-pi-dim">
            通常 <span className="text-pi-text font-medium">{pad2(rhythm.activeStart)}:00–{pad2((rhythm.activeEnd + 1) % 24)}:00</span> 活跃，
            近 {rhythm.spanDays} 天 {rhythm.samples} 条记录（覆盖 {Math.round((rhythm.coverage || 0) * 100)}%）。
            今天已聊 {rhythm.todayCount} 轮{rhythm.lateNightRatio > 0 ? `，其中 ${(rhythm.lateNightRatio * 100).toFixed(0)}% 在凌晨` : ''}。
          </p>
          <div className="mt-2 flex items-end gap-[3px] h-9">
            {(rhythm.hours || []).map((n: number, h: number) => (
              <span key={h} title={`${pad2(h)}:00 · ${n} 条`}
                className={`flex-1 rounded-sm ${n > 0 ? 'bg-pi-accent/30' : 'bg-pi-border-soft/40'}`}
                style={{ height: `${Math.max(6, (n / rhythmMax) * 100)}%` }} />
            ))}
          </div>
          <p className="text-[10px] text-pi-dim2 mt-1.5">这份读数会随「时间感」一起进提示词：深夜时它先确认你还在忙什么，而不是当成正常工作时间。</p>
        </div>
      )}

      {/* 跨轮目标：引擎侧三重闸门，台前只做"人类给结论"这一侧 */}
      <GoalSection />

      {/* 待兑现承诺：小语自己许下的「明天/回头/下次」，结清只能由人给结论 */}
      <PromiseSection />

      {/* 记忆快照：可回退（此前只写不读） */}
      <SnapshotSection onRestored={() => mutate()} />

      {/* 建议 */}
      {(rep.recommendations?.length || 0) > 0 && (
        <div className="panel !p-3">
          <h3 className="text-[13px] font-semibold text-pi-text mb-2">园丁建议</h3>
          <ul className="space-y-1.5">
            {rep.recommendations.map((x: string, i: number) => <li key={i} className="text-[12px] text-pi-dim flex gap-2"><span className="text-pi-accent mt-0.5">•</span><span>{x}</span></li>)}
          </ul>
        </div>
      )}

      {busy === 'dedupe' && <div className="text-xs text-pi-accent animate-pulse">正在去重并写备份…</div>}
    </div>
  )
}
