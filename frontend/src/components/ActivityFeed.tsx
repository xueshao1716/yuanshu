import { Activity, Bot, BrainCircuit, CircleAlert, CircleCheck, CircleDot, Moon, Play, Power, Satellite as EmptyActivityIcon, Square, UserRound, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentEventsApi, type AgentEvent } from '../api'
import EmptyState from './EmptyState'

// Durable run summaries plus labelled external reports; current status comes from the run ledger.

const ICONS: Record<string, LucideIcon> = {
  thinking: BrainCircuit, turn_start: Play, tool_start: Wrench, tool_end: CircleCheck,
  user_message: UserRound, assistant_reply: Bot, task_completed: CircleCheck,
  turn_end: Square, error: CircleAlert, session_start: CircleDot, session_shutdown: Power,
  agent_settled: Moon,
}

const LABELS: Record<string, string> = {
  queued: '排队中', running: '执行中', stopping: '停止中', completed: '已完成',
  failed: '失败', stopped: '已停止', interrupted: '已中断', paused: '已暂停',
  tool_start: '调用工具', tool_end: '工具完成', assistant_reply: '回复',
  thinking: '思考中', user_message: '你的消息', turn_start: '回合开始',
  turn_end: '回合结束', task_completed: '任务完成', error: '出错',
  session_start: '会话启动', session_shutdown: '会话停止', agent_settled: '进入休息',
}

function describe(ev: AgentEvent): string {
  if (ev.source === 'run-ledger') return `${LABELS[ev.type] || ev.type} · ${ev.data?.text || '任务'}`
  if (ev.type === 'tool_start') return `调用工具 ${ev.data?.tool || ''}`
  if (ev.type === 'user_message') return `你：${(ev.data?.text || '').slice(0, 40)}`
  if (ev.type === 'assistant_reply') return `小语：${(ev.data?.text || '').slice(0, 40)}`
  if (ev.type === 'thinking') return '思考中'
  if (ev.type === 'task_completed') return ev.data?.text || '任务完成' // 08-29：终端交付通报直接展示内容
  return LABELS[ev.type] || ev.type
}

export default function ActivityFeed() {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [err, setErr] = useState(false)
  const [activeCount, setActiveCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    let pending = false
    const load = async () => {
      if (document.visibilityState !== 'visible' || pending) return
      pending = true
      try {
        const r = await AgentEventsApi.get()
        if (alive) { setEvents(r.events || []); setActiveCount(r.activeCount ?? null); setErr(false) }
      } catch { if (alive) setErr(true) }
      finally { pending = false; if (alive) setLoading(false) }
    }
    load()
    // 2026-09-20：2s → 5s。外网每个请求 ~0.8s（隧道往返），2 秒轮等于请求永远在飞；
    // 5 秒观感仍是实时的，外网负担降到 1/2.5。
    timer.current = setInterval(load, 5000)
    return () => { alive = false; if (timer.current) clearInterval(timer.current) }
  }, [])

  const status = err ? '状态暂不可确认' : loading ? '正在读取执行记录…' : activeCount == null ? '仅有历史上报，当前状态未知' : activeCount > 0 ? `${activeCount} 项任务执行中或排队中` : '当前无执行中任务'

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* 状态条：一眼看出小语此刻在干嘛 */}
      <div className="mx-3 mt-3 flex items-center gap-2 px-3 py-2.5 rounded-pi-md bg-pi-bg2/60 border border-pi-border-soft text-xs">
        <span className={`w-2 h-2 shrink-0 rounded-full ${!err && !!activeCount ? 'bg-pi-green' : 'bg-pi-dim2'}`} />
        <span className="text-pi-text/90">{status}</span>
      </div>

      {/* 事件时间线：最新在上 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5">
        {err && <div role="alert" className="text-sm text-pi-text p-3">刷新失败，稍后自动重试。下方若有记录，是上次读取的历史。</div>}
        {loading ? <p role="status" className="text-sm text-pi-dim p-3">正在读取活动…</p> : !events.length ? (
          !err && <EmptyState icon={EmptyActivityIcon} title="暂无活动记录" hint="当前工作空间的任务执行账本会显示在这里" />
        ) : (
          events.slice().reverse().slice(0, 40).map((ev, i) => (
            <div key={ev.id || `${ev.ts}-${i}`} className="flex gap-2 items-start px-2 py-1.5 rounded-pi-sm hover:bg-pi-bg2/50 text-xs leading-relaxed">
              {(() => { const Icon = ICONS[ev.type] || Activity; return <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-pi-dim2" strokeWidth={1.8} aria-hidden="true" /> })()}
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <p className="text-pi-text">{describe(ev)}</p>
                <p className="text-pi-dim text-xs mt-1">{new Date(ev.ts).toLocaleString('zh-CN', { hour12: false })} · {ev.source === 'run-ledger' ? '执行账本' : '外部上报'}{typeof ev.data?.engine === 'string' ? ` · ${ev.data.engine}` : ''}</p>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-pi-border-soft flex items-center gap-1.5 text-[10px] text-pi-dim2">
        <Activity className="w-3 h-3" strokeWidth={1.8} /> 每 5 秒自动刷新 · 最多显示最近 40 条
      </div>
    </div>
  )
}
