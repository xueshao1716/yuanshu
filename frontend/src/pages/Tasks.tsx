import { useRef, useState } from 'react'
import { Trash2, Play, Pause, RotateCcw, Archive, ChevronDown, ChevronRight, Loader2, Square, CalendarClock, Clock3, AlertTriangle, Plus, CheckCircle2, CircleX, Timer, ChevronUp } from 'lucide-react'
import useSWR from 'swr'
import { TasksApi } from '../api'
import type { TimeTask } from '../api'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'

// ── 任务中心 v2（08-25，MyAgents 路线）：状态机 / 手动执行 / 运行历史 ──

const DAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
const TYPE_LABEL: Record<string, string> = { daily: '每天', weekly: '每周', once: '单次' }

function describe(t: TimeTask): string {
  if (t.type === 'weekly') return `${DAY_LABEL[t.day || 1]} ${t.at}`
  if (t.type === 'once') return `${t.date} ${t.at}`
  return `每天 ${t.at}`
}

const STATE_BADGE: Record<string, { label: string; color: string; icon: typeof Play }> = {
  active:   { label: '调度中', color: 'bg-pi-success/15 text-pi-success border-pi-success/30', icon: Play },
  paused:   { label: '已暂停', color: 'bg-pi-warning/15 text-pi-warning border-pi-warning/30', icon: Pause },
  done:     { label: '已完成', color: 'bg-pi-bg3 text-pi-dim border-pi-border', icon: RotateCcw },
  archived: { label: '已归档', color: 'bg-pi-bg3 text-pi-dim2 border-pi-border-soft', icon: Archive },
}

function StateBadge({ state }: { state: string }) {
  const b = STATE_BADGE[state] || STATE_BADGE.active
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pi-pill text-[10px] font-medium border ${b.color}`}>
      <b.icon className="w-3 h-3" strokeWidth={2} />{b.label}
    </span>
  )
}

type TaskRun = NonNullable<TimeTask['history']>[number]

const RUN_STATUS: Record<string, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  ok: { label: '成功', tone: 'text-pi-success bg-pi-success/10 border-pi-success/25', icon: CheckCircle2 },
  error: { label: '失败', tone: 'text-pi-danger bg-pi-danger/10 border-pi-danger/25', icon: CircleX },
  stopped: { label: '已停止', tone: 'text-pi-warning bg-pi-warning/10 border-pi-warning/25', icon: Square },
  stop_requested: { label: '停止中', tone: 'text-pi-warning bg-pi-warning/10 border-pi-warning/25', icon: Square },
}

function runStatus(status: string) {
  return RUN_STATUS[status] || { label: status || '未知', tone: 'text-pi-dim2 bg-pi-bg3 border-pi-border-soft', icon: Timer }
}

function formatRunDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '不到 1 秒'
  if (durationMs < 1000) return `${durationMs} ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`
}

function runDateKey(startedAt: string) {
  const date = new Date(startedAt)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function runDateLabel(key: string) {
  if (key === 'unknown') return '时间未知'
  const date = new Date(`${key}T00:00:00`)
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
}

function formatRunTime(startedAt: string) {
  const date = new Date(startedAt)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function runTimestamp(startedAt: string) {
  const value = new Date(startedAt).getTime()
  return Number.isFinite(value) ? value : 0
}

function RunHistory({ id }: { id: string }) {
  const { data, isLoading } = useSWR(`task-history-${id}`, () => TasksApi.history(id), { dedupingInterval: 5000 })
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set())
  if (isLoading) return <div className="text-[11px] text-pi-dim2 py-2">加载历史…</div>
  const hist = data?.history || []
  if (!hist.length) return <div className="text-[11px] text-pi-dim2 py-2">暂无运行记录</div>

  // 历史最多展示最近 10 条，先按自然日分组，让长记录变成可扫描的时间轴。
  // 后端通常按最新在前返回，但历史是用户最关心的时间线，前端仍按时间再排一次，
  // 防止旧版本或外部写入导致“最近运行”顺序错乱。
  const visibleHistory = [...hist]
    .sort((a, b) => runTimestamp(b.startedAt) - runTimestamp(a.startedAt) || String(b.queueId).localeCompare(String(a.queueId)))
    .slice(0, 10)
  const groups = visibleHistory.reduce<{ key: string; label: string; items: TaskRun[] }[]>((all, run) => {
    const key = runDateKey(run.startedAt)
    const group = all.find(item => item.key === key)
    if (group) group.items.push(run)
    else all.push({ key, label: runDateLabel(key), items: [run] })
    return all
  }, [])
  const successCount = visibleHistory.filter(run => run.status === 'ok').length
  const failureCount = visibleHistory.filter(run => run.status === 'error').length
  const averageDuration = formatRunDuration(visibleHistory.reduce((total, run) => total + (Number(run.durationMs) || 0), 0) / visibleHistory.length)
  const toggleResult = (queueId: string) => setExpandedResults(prev => {
    const next = new Set(prev)
    next.has(queueId) ? next.delete(queueId) : next.add(queueId)
    return next
  })

  return (
    <div className="task-history mt-3 pt-3 border-t border-pi-border-soft" data-slot="task-history">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-pi-text">最近运行</span>
            <span className="text-[10px] text-pi-dim2">按日期分组</span>
          </div>
          <div className="mt-0.5 text-[11px] text-pi-dim2">最近 {visibleHistory.length} 次执行记录</div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] tabular-nums">
          <span className="inline-flex items-center gap-1 rounded-pi-pill border border-pi-success/25 bg-pi-success/10 px-1.5 py-0.5 text-pi-success"><CheckCircle2 className="h-3 w-3" />{successCount} 成功</span>
          {failureCount > 0 && <span className="inline-flex items-center gap-1 rounded-pi-pill border border-pi-danger/25 bg-pi-danger/10 px-1.5 py-0.5 text-pi-danger"><CircleX className="h-3 w-3" />{failureCount} 失败</span>}
          <span className="hidden items-center gap-1 rounded-pi-pill border border-pi-border-soft bg-pi-bg3 px-1.5 py-0.5 text-pi-dim2 sm:inline-flex"><Timer className="h-3 w-3" />平均耗时 {averageDuration}</span>
        </div>
      </div>

      <div className="mt-3 space-y-4">
        {groups.map(group => (
          <section key={group.key} aria-label={`${group.label}运行记录`}>
            <div className="mb-1.5 flex items-center gap-2 px-0.5">
              <span className="h-1.5 w-1.5 rounded-full bg-pi-accent" aria-hidden="true" />
              <span className="text-[11px] font-medium text-pi-dim">{group.label}</span>
              <span className="text-[10px] text-pi-dim2">{group.items.length} 次</span>
              <span className="h-px flex-1 bg-pi-border-soft" aria-hidden="true" />
            </div>
            <div className="space-y-2">
              {group.items.map(h => {
                const status = runStatus(h.status)
                const StatusIcon = status.icon
                const isResultExpanded = expandedResults.has(h.queueId)
                const result = String(h.result || '').trim()
                // The card keeps the complete source field ({h.result}); CSS only controls the collapsed preview.
                const hasLongResult = result.length > 180 || result.includes('\n')
                return (
                  <article key={h.queueId} className="task-run-card rounded-pi-md border border-pi-border-soft bg-pi-bg2/45 px-3 py-2.5 transition-colors hover:border-pi-border-hi hover:bg-pi-bg2/70">
                    <div className="task-run-card__body flex items-start gap-2.5">
                      <div className={`task-run-card__status-icon mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-pi-sm border ${status.tone}`}>
                        <StatusIcon className="h-3.5 w-3.5" strokeWidth={1.9} aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center rounded-pi-pill border px-1.5 py-0.5 text-[10px] font-medium ${status.tone}`}>{status.label}</span>
                          <time className="text-[11px] font-medium tabular-nums text-pi-text" dateTime={h.startedAt}>{formatRunTime(h.startedAt)}</time>
                          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-pi-dim2"><Timer className="h-3 w-3" />{formatRunDuration(h.durationMs)}</span>
                        </div>
                        <div className="task-run-result mt-1.5 flex items-start gap-2">
                          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-pi-dim2">任务结果</span>
                          {result ? (
                            <p className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-pi-text/90 ${!isResultExpanded && hasLongResult ? 'line-clamp-2' : ''}`}>{result}</p>
                          ) : <p className="text-[11px] text-pi-dim2">没有返回内容</p>}
                        </div>
                        {result && hasLongResult && (
                          <button type="button" className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-pi-accent hover:text-pi-accent2" aria-expanded={isResultExpanded} onClick={() => toggleResult(h.queueId)}>
                            {isResultExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            {isResultExpanded ? '收起结果' : '查看完整结果'}
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export default function Tasks() {
  const { data, mutate, isLoading } = useSWR('time-tasks', () => TasksApi.list(), { refreshInterval: 15000 })
  const tasks = data?.tasks || []
  const [form, setForm] = useState({ type: 'daily', at: '09:00', day: 1, date: '', prompt: '', label: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const formRef = useRef<HTMLElement>(null)
  const formPromptRef = useRef<HTMLTextAreaElement>(null)

  const toggleHistory = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const focusCreateForm = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    formPromptRef.current?.focus({ preventScroll: true })
  }

  const doAction = async (id: string, fn: () => Promise<any>) => {
    setActionBusy(id)
    try { await fn(); await mutate() } catch {} finally { setActionBusy(null) }
  }

  const submit = async () => {
    setErr('')
    if (!form.prompt.trim()) { setErr('请填写要执行的指令（prompt）'); return }
    setBusy(true)
    try {
      const body: any = { type: form.type, at: form.at, prompt: form.prompt.trim(), label: form.label.trim() || form.prompt.trim().slice(0, 20) }
      if (form.type === 'weekly') body.day = form.day
      if (form.type === 'once') body.date = form.date
      const r = await TasksApi.create(body)
      if (r.error) setErr(r.error)
      else { await mutate(); setForm(f => ({ ...f, prompt: '', label: '' })) }
    } catch (e: any) { setErr(e?.message || String(e)) } finally { setBusy(false) }
  }

  const activeCount = tasks.filter(t => t.state === 'active').length
  const runningCount = tasks.filter(t => t.running).length

  return (
    <div className="flex-1 overflow-y-auto relative z-10">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
        <PageHeader
          title="任务中心"
          description="把想法安排为可调度任务，并在同一处追踪执行状态与运行历史。"
          meta={(activeCount > 0 || runningCount > 0) ? (
            <div className="flex items-center gap-3 text-[11px]">
              {activeCount > 0 && <span className="text-pi-accent">{activeCount} 个调度中</span>}
              {runningCount > 0 && <span className="text-pi-success">{runningCount} 个执行中</span>}
            </div>
          ) : undefined}
        />

        {/* 任务列表 */}
        <section className="mb-8">
          <SectionHeader title="任务列表" description="查看调度状态、立即执行或展开最近的运行记录。" />
          <div className="space-y-2.5">
          {isLoading && <div className="text-center text-pi-dim2 text-[13px] py-8">加载中…</div>}
          {!isLoading && !tasks.length && (
            <EmptyState
              icon={CalendarClock}
              title="还没有任务"
              hint="创建第一个任务，比如每天早上让小语整理工作空间。"
              action={{ label: '创建第一个任务', onClick: focusCreateForm }}
            />
          )}
          {tasks.map(t => {
            const isExpanded = expanded.has(t.id)
            const canRun = t.state === 'active' && !t.running
            const canPause = t.state === 'active'
            const canResume = t.state === 'paused'
            const canArchive = t.state !== 'archived'

            return (
              <div key={t.id} className={`task-card panel !p-3.5 card-hover group/task group ${t.running ? 'ring-1 ring-pi-accent/30' : ''}`}>
                <div className="task-card__body flex items-start gap-3">
                  <div className="w-11 h-11 rounded-pi-md bg-pi-accent/12 border border-pi-accent/25 flex flex-col items-center justify-center flex-shrink-0"
                    style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,.06)' }}>
                    <span className="text-[10px] text-pi-accent leading-none font-semibold tracking-wide">{TYPE_LABEL[t.type]}</span>
                    <span className="text-[12px] font-bold text-pi-text leading-tight tabular-nums">{t.at}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] text-pi-text font-medium truncate">{t.label || t.prompt.slice(0, 30)}</span>
                      <StateBadge state={t.state || 'active'} />
                      {t.running && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-pi-accent animate-pulse">
                          <Loader2 className="w-3 h-3 animate-spin" />执行中
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-pi-dim2 mt-0.5 line-clamp-2">{t.prompt}</div>
                    <div className="text-[11px] text-pi-dim2 mt-1.5 flex gap-3 flex-wrap items-center">
                      <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 inline-flex items-center gap-1"><Clock3 className="w-3 h-3" aria-hidden="true" />{describe(t)}</span>
                      <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3">已跑 {t.runs || 0} 次</span>
                      {t.lastRun && <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3">上次 {new Date(t.lastRun).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
                      {t.history?.length > 0 && (
                        <button onClick={() => toggleHistory(t.id)} className="text-pi-dim2 hover:text-pi-text transition-colors inline-flex items-center gap-0.5">
                          {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          历史
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="task-card__actions hov-reveal touch-hit flex items-center gap-1 flex-shrink-0">
                    {/* 立即执行 */}
                    {canRun && (
                      <button title="立即执行" aria-label="立即执行" disabled={actionBusy === t.id}
                        className="btn-tool !px-2 text-pi-dim2 hover:text-pi-success disabled:opacity-50"
                        onClick={() => doAction(t.id, () => TasksApi.runNow(t.id))}>
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    {t.running && (
                      <button title="停止" aria-label="停止执行" disabled={actionBusy === t.id}
                        className="btn-tool !px-2 text-pi-dim2 hover:text-pi-warning disabled:opacity-50"
                        onClick={() => doAction(t.id, () => TasksApi.stopRun(t.id))}>
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {/* 暂停/恢复 */}
                    {canPause && (
                      <button title="暂停" aria-label="暂停任务" disabled={actionBusy === t.id}
                        className="btn-tool !px-2 text-pi-dim2 hover:text-pi-warning disabled:opacity-50"
                        onClick={() => doAction(t.id, () => TasksApi.setState(t.id, 'pause'))}>
                        <Pause className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {canResume && (
                      <button title="恢复" aria-label="恢复任务" disabled={actionBusy === t.id}
                        className="btn-tool !px-2 text-pi-dim2 hover:text-pi-success disabled:opacity-50"
                        onClick={() => doAction(t.id, () => TasksApi.setState(t.id, 'resume'))}>
                        <Play className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {canArchive && (
                      <button title="归档" aria-label="归档任务" disabled={actionBusy === t.id}
                        className="btn-tool !px-2 text-pi-dim2 hover:text-pi-dim disabled:opacity-50"
                        onClick={() => doAction(t.id, () => TasksApi.setState(t.id, 'archive'))}>
                        <Archive className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button title="删除任务" aria-label={`删除任务 ${t.label || t.prompt.slice(0, 20)}`}
                      className="btn-tool !px-2 text-pi-dim2 hover:text-pi-danger"
                      onClick={() => doAction(t.id, () => TasksApi.remove(t.id))}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                {/* 运行历史（展开时加载） */}
                {isExpanded && t.history?.length > 0 && (
                  <div className="task-history-shell ml-14 mt-2 pl-3 border-l border-pi-border-soft">
                    <RunHistory id={t.id} />
                  </div>
                )}
              </div>
            )
          })}
          </div>
        </section>

        {/* 新建表单 */}
        <section ref={formRef} className="scroll-mt-6">
          <SectionHeader title="新建任务" description="设置执行频率和指令；创建后仍可暂停、恢复、归档或删除。" />
          <div className="panel !p-3 space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <div className="flex rounded-pi-md overflow-hidden border border-pi-border">
              {(['daily', 'weekly', 'once'] as const).map(tp => (
                <button key={tp} onClick={() => setForm(f => ({ ...f, type: tp }))}
                  className={`text-xs px-3 py-1.5 transition-colors ${form.type === tp ? 'bg-pi-accent text-pi-on-accent' : 'bg-pi-bg2 text-pi-dim hover:text-pi-text'}`}>
                  {TYPE_LABEL[tp]}
                </button>
              ))}
            </div>
            <input type="time" className="input-pi !py-1.5 text-xs w-28" value={form.at}
              onChange={e => setForm(f => ({ ...f, at: e.target.value }))} />
            {form.type === 'weekly' && (
              <select className="input-pi !py-1.5 text-xs w-24" value={form.day}
                onChange={e => setForm(f => ({ ...f, day: +e.target.value }))}>
                {DAY_LABEL.slice(1).map((l, i) => <option key={l} value={i + 1}>{l}</option>)}
              </select>
            )}
            {form.type === 'once' && (
              <input type="date" className="input-pi !py-1.5 text-xs w-40" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            )}
          </div>
          <textarea ref={formPromptRef} className="input-pi text-[13px] resize-none" rows={3} placeholder="到点让小语做什么？如：整理今天工作空间的生成图片，发一份清单到会话"
            value={form.prompt} onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))} />
          <div className="flex items-center gap-2">
            <input className="input-pi !py-1.5 text-xs flex-1" placeholder="任务名（可选）" value={form.label}
              onChange={e => setForm(f => ({ ...f, label: e.target.value }))} />
            <button className="btn-primary text-xs px-4 py-1.5 disabled:opacity-60 inline-flex items-center gap-1.5" onClick={submit} disabled={busy}>
              {!busy && <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
          {err && <div className="text-[12px] text-pi-danger inline-flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{err}</div>}
          </div>
        </section>
      </div>
    </div>
  )
}
