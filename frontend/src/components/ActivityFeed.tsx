import { Activity, Bot, BrainCircuit, CircleAlert, CircleCheck, CircleDot, Moon, Play, Power, Satellite as EmptyActivityIcon, Square, UserRound, Wrench, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { AgentEventsApi, type AgentEvent } from '../api'
import EmptyState from './EmptyState'

// 小语活动实时流（2026-08-26，对标 vanilla 活动面板）：2s 轮询 /api/agent/events，
// 状态条推断当前在干嘛 + 事件时间线（最新在上，最多 40 条）。挂载才轮询，卸载即停。

const ICONS: Record<string, LucideIcon> = {
  thinking: BrainCircuit, turn_start: Play, tool_start: Wrench, tool_end: CircleCheck,
  user_message: UserRound, assistant_reply: Bot, task_completed: CircleCheck,
  turn_end: Square, error: CircleAlert, session_start: CircleDot, session_shutdown: Power,
  agent_settled: Moon,
}

const LABELS: Record<string, string> = {
  tool_start: '调用工具', tool_end: '工具完成', assistant_reply: '回复',
  thinking: '思考中', user_message: '你的消息', turn_start: '回合开始',
  turn_end: '回合结束', task_completed: '任务完成', error: '出错',
  session_start: '会话启动', session_shutdown: '会话停止', agent_settled: '进入休息',
}

function describe(ev: AgentEvent): string {
  if (ev.type === 'tool_start') return `调用工具 ${ev.data?.tool || ''}`
  if (ev.type === 'user_message') return `你：${(ev.data?.text || '').slice(0, 40)}`
  if (ev.type === 'assistant_reply') return `小语：${(ev.data?.text || '').slice(0, 40)}`
  if (ev.type === 'thinking') return '思考中'
  if (ev.type === 'task_completed') return ev.data?.text || '任务完成' // 08-29：终端交付通报直接展示内容
  return LABELS[ev.type] || ev.type
}

function inferStatus(evs: AgentEvent[]): { text: string; tone: 'run' | 'think' | 'idle' } {
  const last = evs[evs.length - 1]
  if (!last) return { text: '空闲', tone: 'idle' }
  if (last.type === 'tool_start') return { text: `正在 ${last.data?.tool || '调用工具'}`, tone: 'run' }
  if (last.type === 'thinking' || last.type === 'turn_start') return { text: '思考中…', tone: 'think' }
  if (last.type === 'assistant_reply' || last.type === 'tool_end') return { text: '工作中', tone: 'run' }
  if (last.type === 'session_shutdown') return { text: '已停止', tone: 'idle' }
  return { text: '空闲', tone: 'idle' }
}

const TONE_COLOR = { run: 'var(--pi-green)', think: 'var(--pi-yellow)', idle: 'var(--pi-dim2)' } as const

export default function ActivityFeed() {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [err, setErr] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      if (document.visibilityState !== 'visible') return // 后台标签不空转
      try {
        const r = await AgentEventsApi.get()
        if (alive) { setEvents(r.events || []); setErr(false) }
      } catch { if (alive) setErr(true) }
    }
    load()
    // 2026-09-20：2s → 5s。外网每个请求 ~0.8s（隧道往返），2 秒轮等于请求永远在飞；
    // 5 秒观感仍是实时的，外网负担降到 1/2.5。
    timer.current = setInterval(load, 5000)
    return () => { alive = false; if (timer.current) clearInterval(timer.current) }
  }, [])

  const status = inferStatus(events)

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* 状态条：一眼看出小语此刻在干嘛 */}
      <div className="mx-3 mt-3 flex items-center gap-2 px-3 py-2.5 rounded-pi-md bg-pi-bg2/60 border border-pi-border-soft text-xs">
        <span className={`w-2 h-2 rounded-full ${status.tone !== 'idle' ? 'animate-pulse' : ''}`}
          style={{ background: TONE_COLOR[status.tone], boxShadow: status.tone !== 'idle' ? `0 0 8px ${TONE_COLOR[status.tone]}` : 'none' }} />
        <span className="text-pi-text/90">{status.text}</span>
        <span className="ml-auto font-mono text-[10px] text-pi-dim2">
          {events.length ? new Date(events[events.length - 1].ts).toLocaleTimeString('zh-CN', { hour12: false }) : ''}
        </span>
      </div>

      {/* 事件时间线：最新在上 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5">
        {err ? (
          <div className="text-[11px] text-pi-dim2 p-3">活动接口暂不可用</div>
        ) : !events.length ? (
          <EmptyState icon={EmptyActivityIcon} title="暂无活动记录" hint="小语干活时会实时显示在这里" />
        ) : (
          events.slice().reverse().slice(0, 40).map((ev, i) => (
            <div key={`${ev.ts}-${i}`} className="flex gap-2 items-start px-2 py-1.5 rounded-pi-sm hover:bg-pi-bg2/50 text-xs leading-relaxed">
              <span className="font-mono text-[10px] text-pi-dim2 flex-shrink-0 mt-0.5">
                {new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false })}
              </span>
              {(() => { const Icon = ICONS[ev.type] || Activity; return <Icon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-pi-dim2" strokeWidth={1.8} aria-hidden="true" /> })()}
              <span className="text-pi-dim break-words">{describe(ev)}</span>
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-pi-border-soft flex items-center gap-1.5 text-[10px] text-pi-dim2">
        <Activity className="w-3 h-3" strokeWidth={1.8} /> 每 2 秒自动刷新 · 最多显示最近 40 条
      </div>
    </div>
  )
}
