import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {MessagesSquare, Clock4, Wallet, Activity as ActivityIcon, Package,
  Play, Pause, CheckCircle2, AlertTriangle, ArrowRight,
  LayoutDashboard, GitCompare, Users } from 'lucide-react'
import { api, SessionsApi, TasksApi, StatsApi, WsApi, SubagentApi, EmotionApi, RunApi, type TimeTask } from '../api'
import { useApp } from '../store'
import { useEmotionSummary } from '../lib/useEmotionSummary'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import ActivityFeed from '../components/ActivityFeed'
import { MoodOrb } from '../components/MoodOrb'
import { useXiaoyuEmotion } from '../lib/useXiaoyuEmotion'
import HealthBadge from '../components/HealthBadge'
import WorkExplanationList from '../components/WorkExplanationList'
import { ReviewPanel } from './ReviewWorkbench'
import { PendingChanges } from '../components/PendingChanges'
import { HistoryPanel } from '../components/HistoryPanel'
import { TeamRunView } from '../components/TeamRunView'
import BoardWelcome, { BoardShortcuts } from '../components/board/BoardWelcome'
import BoardFocus from '../components/board/BoardFocus'
import { chooseResumeSession } from '../lib/board-home-state.mjs'
import '../components/board/board-home.css'

// 概览优先呈现会话、真实执行状态和交付；详细记录与用量按需展开。

const isToday = (iso?: string) => {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

const fmtCost = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
const fmtTokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)

const DAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
const describeTask = (t: TimeTask) => {
  if (t.type === 'weekly') return `${DAY_LABEL[t.day || 1]} ${t.at}`
  if (t.type === 'once') return `${t.date} ${t.at}`
  return `每天 ${t.at}`
}

function StatCard({ icon: Icon, label, value, hint, tone }: {
  icon: typeof Clock4; label: string; value: string; hint?: string; tone?: 'accent'
}) {
  return (
    <div className={`panel p-4 flex items-start gap-3 card-hover`}>
      <span className={`w-9 h-9 rounded-pi-md flex items-center justify-center flex-shrink-0 ${tone === 'accent' ? 'bg-pi-accent-soft text-pi-accent' : 'bg-pi-bg3 text-pi-dim'}`}>
        <Icon className="w-[18px] h-[18px]" strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <div className="text-[11px] text-pi-dim2 leading-none mb-1.5">{label}</div>
        <div className="text-[17px] font-semibold text-pi-text leading-none tabular-nums">{value}</div>
        {hint && <div className="text-[10px] text-pi-dim2 mt-1.5 leading-none">{hint}</div>}
      </div>
    </div>
  )
}

function Lane({ title, icon: Icon, count, accent, children }: {
  title: string; icon: typeof Play; count: number; accent?: boolean; children: React.ReactNode
}) {
  return (
    <div className="panel p-3 flex flex-col min-h-[220px]">
      <div className="lane-head flex items-center gap-2 px-1 pb-2.5 mb-2 border-b border-pi-border-soft">
        <Icon className={`w-4 h-4 ${accent ? 'text-pi-accent' : 'text-pi-dim'}`} strokeWidth={2} />
        <span className="text-[12px] font-semibold text-pi-text">{title}</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim tabular-nums">{count}</span>
      </div>
      <div className="flex-1 flex flex-col gap-2">{children}</div>
    </div>
  )
}

function TaskCard({ t, mode }: { t: TimeTask; mode: 'running' | 'scheduled' | 'done' }) {
  return (
    <div className="rounded-pi-md border border-pi-border-soft bg-pi-bg1 hover:border-pi-border transition-colors p-2.5">
      <div className="flex items-center gap-1.5 min-w-0">
        {mode === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-pi-accent animate-pulse flex-shrink-0" />}
        <span className="text-[12px] font-medium text-pi-text truncate">{t.label || t.prompt.slice(0, 24)}</span>
      </div>
      <div className="flex items-center gap-2 mt-1 text-[10px] text-pi-dim2">
        {mode === 'scheduled'
          ? <><Clock4 className="w-3 h-3" />{describeTask(t)}</>
          : mode === 'running'
            ? <><Play className="w-3 h-3" />执行中{t.lastRun ? ` · 上次 ${t.lastRun.slice(11, 16)}` : ''}</>
            : <><CheckCircle2 className="w-3 h-3" />{t.state === 'archived' ? '已归档' : '已完成'}{t.runs ? ` · 共 ${t.runs} 次` : ''}</>}
      </div>
    </div>
  )
}

function UsageChart({ days }: { days: { label: string; input: number; output: number; cost: number; messages: number }[] }) {
  const max = Math.max(1, ...days.map(d => d.input + d.output))
  const totalCost = days.reduce((a, d) => a + d.cost, 0)
  return (
    <div className="flex items-end gap-2 h-[110px] px-1">
      {days.map(d => {
        const h = Math.round(((d.input + d.output) / max) * 100)
        return (
          <div key={d.label} className="flex-1 flex flex-col items-center gap-1 h-full justify-end group" title={`${d.label} · ${fmtTokens(d.input + d.output)} tokens · ${fmtCost(d.cost)} · ${d.messages} 条`}>
            <div className="w-full max-w-[34px] rounded-t-pi-sm bg-pi-accent/35 hover:bg-pi-accent/55 transition-colors relative overflow-hidden" style={{ height: `${Math.max(h, 2)}%` }}>
              {d.output > 0 && <div className="absolute bottom-0 left-0 right-0 bg-pi-accent/55" style={{ height: `${Math.max((d.output / Math.max(1, d.input + d.output)) * 100, 6)}%` }} />}
            </div>
            <span className="text-[10px] text-pi-dim2 tabular-nums">{d.label}</span>
          </div>
        )
      })}
      <span className="absolute right-4 top-3 text-[10px] text-pi-dim2">7日 {fmtCost(totalCost)}</span>
    </div>
  )
}

type BoardView = 'overview' | 'review' | 'team'

// 页内多视图（沿用 Apps.tsx 的模式）：概览 = 运行态总览；改动验收 = 原独立页，
// 因其板块与工作台重复（近期工作说明、子智能体记录）而并入，不再占独立主栏入口。
const BOARD_VIEWS: { key: BoardView; label: string; icon: typeof MessagesSquare }[] = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
  { key: 'review', label: '改动验收', icon: GitCompare },
  { key: 'team', label: '天团', icon: Users },   // 多AI角色扮演系统：运行态只读窗口
]

export default function Board({ initialView = 'overview' }: { initialView?: BoardView }) {
  const [view, setView] = useState<BoardView>(initialView)
  const { selectSession } = useApp()
  // 首屏一条打包（2026-09-20）：外网每个请求 ~0.8s（隧道往返），原来首屏要打 9 条 → 现在 1 条。
  // 下面每条仍保留自己的轮询（数据各自刷新），但用 fallbackData 先把首屏喂饱、且挂载时不重复请求。
  const { data: bootData, error: bootError } = useSWR('board-bootstrap', () => api('/api/board/bootstrap'), { refreshInterval: 60_000 })
  const bootFb = (pick: (b: any) => any) => { try { const v = bootData ? pick(bootData) : undefined; return v && !v.__error && !v.error ? v : undefined } catch { return undefined } }
  const { data: sessData, error: sessError, mutate: refreshSessions } = useSWR('sessions', () => SessionsApi.list(), { refreshInterval: 30_000, fallbackData: bootFb((d: any) => (Array.isArray(d.sessions) ? { sessions: d.sessions } : undefined)), revalidateOnMount: false })
  const { data: taskData, error: taskError } = useSWR('board-tasks', () => TasksApi.list(), { refreshInterval: 15_000 })
  const { data: statData, mutate: refreshStats } = useSWR('board-stats', () => StatsApi.providers(), { refreshInterval: 120_000, fallbackData: bootFb((d: any) => d.providers), revalidateOnMount: false })
  const { data: delivData, error: delivError, mutate: refreshDeliveries } = useSWR('board-deliveries', () => WsApi.deliveries(), { refreshInterval: 60_000, fallbackData: bootFb((d: any) => d.deliveries), revalidateOnMount: false })
  const { data: dailyData, mutate: refreshDaily } = useSWR('board-daily', () => StatsApi.daily(), { refreshInterval: 120_000, fallbackData: bootFb((d: any) => d.daily), revalidateOnMount: false })
  const { data: saData, error: saError, mutate: refreshSubagent } = useSWR('board-subagent', () => SubagentApi.runs(), { refreshInterval: 20_000, fallbackData: bootFb((d: any) => d.subagent), revalidateOnMount: false })
  const { data: runData, error: runError, mutate: refreshRuns } = useSWR('board-run-overview', () => RunApi.overview(), { refreshInterval: 20_000, fallbackData: bootFb((d: any) => d.overview), revalidateOnMount: false })
  const bootIncomplete = !!bootData && ['sessions', 'providers', 'deliveries', 'daily', 'subagent', 'overview'].some(k => !bootData[k] || bootData[k].__error || bootData[k].error)
  useEffect(() => {
    if (!bootError && !bootData) return
    const sections = [['sessions', refreshSessions], ['providers', refreshStats], ['deliveries', refreshDeliveries], ['daily', refreshDaily], ['subagent', refreshSubagent], ['overview', refreshRuns]] as const
    for (const [key, refresh] of sections) {
      const value = bootData?.[key]
      if (bootError || !value || value.__error || value.error) void refresh().catch(() => {})
    }
  }, [bootData, bootError, refreshSessions, refreshStats, refreshDeliveries, refreshDaily, refreshSubagent, refreshRuns])

  const sessions = sessData?.sessions || []
  const tasks = taskData?.tasks || []
  const providers = statData?.providers || []
  const deliveries = [...(delivData?.deliveries || [])].sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')))
  const dailyDays = dailyData?.days || []
  const saRunning = (saData?.runs || []).filter(r => ['running', 'active', 'waiting'].includes(r.state))
  const activeRuns = runData?.active || []
  const sectionError = (key: string, available: boolean) => !available && (bootError || bootData?.[key]?.__error || bootData?.[key]?.error)

  const stats = useMemo(() => {
    const todaySessions = sessions.filter(s => isToday(s.createdAt)).length
    const activeMsgs = sessions.reduce((a, s) => a + (s.messageCount || 0), 0)
    const running = tasks.filter(t => t.running)
    const scheduled = tasks.filter(t => t.state === 'active' && !t.running)
    const finished = tasks.filter(t => t.state === 'done' || t.state === 'archived').slice(0, 6)
    const cost = providers.reduce((a, p) => a + (p.cost || 0), 0)
    const tokens = providers.reduce((a, p) => a + (p.input || 0) + (p.output || 0), 0)
    const msgs = providers.reduce((a, p) => a + (p.messages || 0), 0)
    const todayDelivs = deliveries.filter(d => isToday(d.mtime))
    return { todaySessions, activeMsgs, running, scheduled, finished, cost, tokens, msgs, todayDelivs, deliveries, saRunning, dailyDays }
  }, [sessions, tasks, providers, deliveries, dailyDays, saRunning])

  const lastSession = useMemo(() => chooseResumeSession(sessions), [sessions])

  const paused = tasks.filter(t => t.state === 'paused')
  const goChat = () => { location.hash = '#/chat' }
  const continueLast = () => { if (lastSession) selectSession(lastSession.id); goChat() }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1080px] mx-auto px-4 sm:px-6 py-5 flex flex-col gap-4">
        <PageHeader title="工作台" description="会话、进展与交付，都在这里。" meta={runError || sectionError('overview', !!runData) ? <span role="status" className="text-xs text-pi-dim">运行状态暂不可用</span> : runData?.health?.status ? <HealthBadge status={runData.health.status} label={activeRuns.length ? `${activeRuns.length} 个运行中` : undefined} /> : <span role="status" className="text-xs text-pi-dim">正在读取状态…</span>} />
        {(bootError || bootIncomplete) && <div role="alert" className="panel p-3 text-[12px] text-pi-text">概览部分数据未能加载，正在分项重试；当前数字可能不完整。</div>}

        {/* 视图切换：概览 / 改动验收（移动端 select，桌面分段按钮；沿用 Apps.tsx 的页内多视图模式） */}
        <select
          aria-label="选择工作台视图"
          className="input-pi min-h-11 !py-2 text-[13px] w-full md:hidden"
          value={view}
          onChange={event => setView(event.target.value as BoardView)}
        >
          {BOARD_VIEWS.map(v => <option key={v.key} value={v.key}>{v.label}</option>)}
        </select>
        <nav aria-label="工作台视图" className="hidden md:flex items-center gap-1">
          {BOARD_VIEWS.map(v => (
            <button key={v.key} type="button" aria-current={view === v.key ? 'page' : undefined} onClick={() => setView(v.key)}
              className={`min-h-10 px-3 rounded-pi-md inline-flex items-center gap-2 text-[13px] transition-colors ${view === v.key ? 'nav-active font-medium' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg-hover'}`}>
              <v.icon className="w-4 h-4" strokeWidth={1.8} aria-hidden="true" />
              <span>{v.label}</span>
            </button>
          ))}
        </nav>

        {view === 'review' && <>
          <PendingChanges />
          <HistoryPanel />
          <ReviewPanel />
        </>}

        {view === 'team' && <TeamRunView />}

        {view === 'overview' && <>
        <div className="board-home">
          <BoardWelcome session={lastSession} loaded={!!sessData} error={sessError || sectionError('sessions', !!sessData)} onContinue={continueLast} onNew={() => { selectSession(null); goChat() }} />
          <BoardFocus runs={activeRuns} tasks={stats.running} agents={saRunning} deliveries={deliveries}
            runLoaded={!!runData && !!taskData && !!saData} deliveryLoaded={!!delivData}
            runError={runError || taskError || saError || sectionError('overview', !!runData) || sectionError('subagent', !!saData)}
            deliveryError={delivError || sectionError('deliveries', !!delivData)}
            onSession={id => { selectSession(id); goChat() }} onTeam={() => setView('team')} />
          <BoardShortcuts onTeam={() => setView('team')} />
        </div>

        <details className="panel p-4">
          <summary className="min-h-11 cursor-pointer text-sm font-medium text-pi-text content-center">工作记录与用量</summary>
          <div className="flex flex-col gap-4 pt-3">
        <WorkExplanationList data={runData} error={runError} onOpenSession={id => { selectSession(id); goChat() }} />

        {/* 概览统计卡 */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard icon={MessagesSquare} label="今日会话" value={sessData ? String(stats.todaySessions) : '—'} hint={sessData ? `全部 ${sessions.length} 个会话` : '数据暂未就绪'} />
          <StatCard icon={Clock4} label="定时任务执行中" value={taskData ? String(stats.running.length) : '—'} hint={taskData ? `调度中 ${stats.scheduled.length} · 暂停 ${paused.length}` : '数据暂未就绪'} tone="accent" />
          <StatCard icon={Wallet} label="累计模型成本" value={statData ? fmtCost(stats.cost) : '—'} hint={statData ? `${fmtTokens(stats.tokens)} tokens · ${stats.msgs} 次请求` : '数据暂未就绪'} />
          <StatCard icon={Package} label="今日交付" value={delivData ? String(stats.todayDelivs.length) : '—'} hint={delivData ? `共 ${stats.deliveries.length} 件` : '数据暂未就绪'} tone="accent" />
        </div>

        {/* 泳道看板 + 活动时间线 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Lane title="调度中" icon={Clock4} count={stats.scheduled.length}>
            {stats.scheduled.length === 0
              ? <div className="flex-1 grid place-items-center text-[11px] text-pi-dim2 py-6"><span>去「任务」页创建定时任务</span></div>
              : stats.scheduled.slice(0, 6).map(t => <TaskCard key={t.id} t={t} mode="scheduled" />)}
          </Lane>

          <Lane title="最近完成" icon={CheckCircle2} count={stats.finished.length}>
            {stats.finished.length === 0
              ? <div className="flex-1 grid place-items-center text-[11px] text-pi-dim2 py-6"><span>暂无已完成任务</span></div>
              : stats.finished.map(t => <TaskCard key={t.id} t={t} mode="done" />)}
          </Lane>

        </div>

        {/* 活动时间线 */}
        <EmotionTideCard />

        <div className="panel p-3">
          <div className="lane-head flex items-center gap-2 px-1 pb-2 mb-1 border-b border-pi-border-soft">
            <ActivityIcon className="w-4 h-4 text-pi-dim" strokeWidth={2} />
            <span className="text-[12px] font-semibold text-pi-text">活动时间线</span>
            <span className="ml-auto text-[10px] text-pi-dim2 inline-flex items-center gap-1">实时 <ArrowRight className="w-3 h-3" /></span>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            <ActivityFeed />
          </div>
        </div>

        {/* 7 天用量图表放到后面：先写下一步，再看花了多少 */}
        <div className="panel p-3 relative">
          <div className="flex items-center gap-2 px-1 pb-2 mb-2 border-b border-pi-border-soft">
            <Wallet className="w-4 h-4 text-pi-dim" strokeWidth={2} />
            <span className="text-[12px] font-semibold text-pi-text">近 7 天用量</span>
            <span className="text-[10px] text-pi-dim2">深柱 = 输出 tokens</span>
          </div>
          {dailyDays.length === 0
            ? <div className="h-[110px] grid place-items-center text-[11px] text-pi-dim2">暂无用量数据</div>
            : <UsageChart days={dailyDays} />}
        </div>

        {paused.length > 0 && (
          <div className="panel p-3 flex items-center gap-2.5 border-pi-warning/30">
            <AlertTriangle className="w-4 h-4 text-pi-warning flex-shrink-0" />
            <span className="text-[12px] text-pi-dim">{paused.length} 个任务处于暂停状态，去「任务」页恢复调度。</span>
          </div>
        )}

        {!sessData && !taskData && (
          <EmptyState icon={Clock4} title="工作台" hint="正在拉取会话与任务数据…" />
        )}
          </div>
        </details>
        </>}
      </div>
    </div>
  )
}

// ══ 情绪潮汐卡（09-03）：小语的 VAD 状态 + 长期残留 + valence 曲线 ══
// 情绪是此刻的浪，残留在海底记着潮水——这是潮水的第一次被看见。
function TideBar({ label, value, max = 1, tone }: { label: string; value: number; max?: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, (Math.abs(value) / max) * 100))
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-pi-dim2 w-9 flex-shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-pi-bg3 overflow-hidden relative">
        {value < 0 && <div className={`absolute right-1/2 h-full ${tone} rounded-l-full`} style={{ width: `${pct / 2}%` }} />}
        {value >= 0 && <div className={`absolute left-0 h-full ${tone} rounded-r-full`} style={{ width: `${pct}%` }} />}
        {value < 0 && <div className="absolute left-1/2 top-0 h-full w-px bg-pi-border-soft" />}
      </div>
      <span className="text-[10px] tabular-nums text-pi-dim2 w-8 text-right">{value.toFixed(2)}</span>
    </div>
  )
}

function EmotionTideCard() {
  const { state: snap, meta } = useXiaoyuEmotion()
  // 潮汐 + 感受改走同一条情绪摘要（2026-09-20）：外网每请求 ~0.8s，两条变一条。
  const { tide: tideRaw, feelings: feelingsRaw } = useEmotionSummary()
  const tide = (tideRaw || []).slice(-48)
  const lastFeel = (feelingsRaw || []).slice(-1)[0]
  const r = snap?.residue || {}
  // valence 曲线：SVG 折线，中线 0
  const W = 480, H = 56
  const vals = tide.map(p => p.v ?? 0)
  const minV = Math.min(-0.4, ...vals), maxV = Math.max(0.5, ...vals)
  const px = (i: number) => tide.length > 1 ? 4 + (i / (tide.length - 1)) * (W - 8) : W / 2
  const py = (v: number) => 6 + (1 - (v - minV) / (maxV - minV)) * (H - 12)
  const path = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  const zeroY = py(0)
  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2 px-1 pb-2 mb-2 border-b border-pi-border-soft">
        <MoodOrb state={snap} size={22} />
        <span className="text-[12px] font-semibold text-pi-text">情绪潮汐</span>
        {meta && <span className="text-[10px] px-1.5 py-0.5 rounded-pi-pill bg-pi-bg3 text-pi-dim border border-pi-border-soft">{meta.emoji} {meta.label}</span>}
        <span className="ml-auto text-[10px] text-pi-dim2">{tide.length > 0 ? `近期 ${tide.length} 次情绪波动` : '暂无波动记录'}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-1.5 px-1">
        <div className="space-y-1.5">
          <TideBar label="愉悦" value={snap?.valence ?? 0.2} max={1} tone="bg-pi-accent" />
          <TideBar label="唤醒" value={snap?.arousal ?? 0.3} tone="bg-pi-warning" />
          <TideBar label="主导" value={snap?.dominance ?? 0.55} tone="bg-pi-success" />
        </div>
        <div className="space-y-1.5">
          <TideBar label="温暖" value={r.warmth ?? 0} tone="bg-pi-accent/80" />
          <TideBar label="伤害" value={r.hurt ?? 0} tone="bg-pi-error/80" />
          <TideBar label="好奇" value={r.curiosity ?? 0} tone="bg-pi-info/80" />
        </div>
      </div>
      {lastFeel && (
        <div className="mt-2 px-1 text-[10px] text-pi-dim2 truncate">
          <span className="text-pi-dim">最近触动</span> · {lastFeel.felt} —— “{lastFeel.event}”
        </div>
      )}
      {tide.length > 1 && (
        <div className="mt-2 px-1">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[56px]" preserveAspectRatio="none">
            <line x1="4" y1={zeroY} x2={W - 4} y2={zeroY} className="stroke-pi-border-soft" strokeDasharray="3 3" strokeWidth="1" />
            <path d={path} fill="none" className="stroke-pi-accent" strokeWidth="1.5" />
            {vals.map((v, i) => <circle key={i} cx={px(i)} cy={py(v)} r="1.6" className="fill-pi-accent" opacity="0.7" />)}
          </svg>
          <div className="text-[10px] text-pi-dim2 text-right">愉悦度曲线 · 中线为平静</div>
        </div>
      )}
    </div>
  )
}
