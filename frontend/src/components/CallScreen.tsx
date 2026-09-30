import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, AudioLines, Check, ListTodo, MessageSquareText, Mic, MicOff, Phone, PhoneOff, Square } from 'lucide-react'
import { callError } from '../realtime/errors'
import CallStage from './CallStage'

export type CallState = { phase: string; muted: boolean; error?: string; stage: string; activity: string; failureStage?: string | null
  readyAt: number | null; endedAt: number | null; stageStartedAt: number | null }
type Props = { state: CallState; name?: string; consented: boolean; setConsented: (value: boolean) => void; disabled?: boolean
  modelReady?: boolean; modelPicker?: ReactNode
  transcripts: { role: string; text: string }[]; onTaskText: (text: string) => void; tasks: ReactNode
  pendingTasks: number; taskNotice: string; needsApproval?: boolean
  onStart: () => void; onMute: () => void; onInterrupt: () => void; onStop: () => void; onClose: () => void }
const stages: Record<string, string> = {
  microphone: '请允许使用麦克风', audio: '麦克风已允许，正在准备音频', session: '正在准备当前会话',
  ticket: '正在获取通话连接凭证', socket: '正在连接语音服务', service: '连接已建立，等待语音服务就绪',
}
function clock(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}` }

export default function CallScreen({ state, name = '小语', consented, setConsented, disabled, transcripts, onTaskText, tasks,
  modelReady = true, modelPicker, pendingTasks, taskNotice, needsApproval, onStart, onMute, onInterrupt, onStop, onClose }: Props) {
  const [view, setView] = useState<'call' | 'transcript' | 'tasks'>('call')
  const [now, setNow] = useState(Date.now), titleRef = useRef<HTMLHeadingElement>(null), recordsRef = useRef<HTMLDivElement>(null)
  const active = state.phase !== 'idle', ready = state.phase === 'ready', ended = !active && state.readyAt !== null
  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => {
    if (view !== 'call') recordsRef.current?.focus()
    else if (document.activeElement === document.body) titleRef.current?.focus()
  }, [view])
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, state.readyAt])
  const elapsed = state.readyAt === null ? 0 : Math.max(0, Math.floor(((state.endedAt ?? now) - state.readyAt) / 1000))
  const waiting = active && !ready ? Math.max(0, Math.floor((now - (state.stageStartedAt ?? now)) / 1000)) : 0
  const error = callError(state.error, state.failureStage)
  const status = error || (ready ? state.activity === 'replying' ? `${name}正在回复` : state.muted ? '麦克风已静音，你仍可听到回复'
    : state.activity === 'hearing' ? '正在听你说' : '已连接，可以说话' : active ? stages[state.stage] || '正在连接'
      : ended ? '通话已结束' : '聊聊你的想法')
  const visual = error ? 'error' : !ready ? active ? 'connecting' : 'idle' : state.activity === 'replying' ? 'replying' : state.muted ? 'muted' : state.activity
  return <section aria-label="实时通话" className="voice-screen" data-view={view} data-state={visual}>
    <header className="voice-header">
      <h1 ref={titleRef} tabIndex={-1}>{name}</h1>
      <button type="button" className="voice-back touch-hit" onClick={onClose}><ArrowLeft aria-hidden="true" size={17} />{active ? '结束并返回聊天' : '返回聊天'}</button>
    </header>
    <div className="voice-status" role="status" aria-live="polite">
      <span className="voice-status-dot" aria-hidden="true" /><span>{status}</span>
    </div>
    <div className="voice-body">
      {view === 'call' ? <div className="voice-main">
        <CallStage state={visual} />
        <div className="voice-caption">
          <p className="voice-main-title">{ready ? state.activity === 'replying' ? '灵感，正在回应' : state.muted ? '安静听一会儿' : '此刻，专心说话' : active ? '马上就好' : ended ? '想法留在这里' : '从一句话开始'}</p>
          <p className="voice-secondary">{ready ? '需要看文字时，再打开下方记录' : active ? state.stage === 'microphone' ? '请查看浏览器或系统的授权提示' : '麦克风已授权，正在完成连接' : ended ? '已确认的任务会继续执行，结果回到原聊天' : '聊想法，也可以把事情交给元枢'}</p>
          {active && !ready && waiting >= 8 && <p className="voice-wait">本步骤已等待 {waiting} 秒。你可以随时取消后重试。</p>}
        </div>
        {modelPicker}
        {!active && !ended && <div className="voice-consent">
          <p>语音和当前聊天的有限上下文将发送给阶跃，按通道计费。</p>
          <details><summary className="touch-hit">数据与计费说明</summary><p>最近最多 12 条文字（合计 8000 字符）会随通话发送。电脑任务需在页面单独确认，使用现有文字模型与权限并消耗对应额度。转写仅本次临时显示，刷新或切换聊天会清空；切到后台会自动挂断。</p></details>
          <label className="touch-hit"><input type="checkbox" checked={consented} onChange={e => setConsented(e.target.checked)} />我同意以上数据发送与计费，开启麦克风</label>
        </div>}
      </div> : <div ref={recordsRef} className="voice-records" role="region" aria-label={view === 'transcript' ? '本次通话转写' : '通话任务记录'} tabIndex={-1}>
        <div className="voice-records-heading"><h2>{view === 'transcript' ? '本次转写' : '交给元枢'}</h2><button type="button" className="voice-text-button touch-hit" onClick={() => setView('call')}>回到动态画面</button></div>
        {view === 'transcript' ? <>
          <p className="voice-secondary">转写临时保留，刷新或切换聊天会清空。已确认的任务结果会保存回原聊天。</p>
          {transcripts.length ? <div className="voice-transcripts">{transcripts.map((item, i) => <article key={i} data-role={item.role}>
            <p className="voice-speaker">{item.role === 'user' ? '你' : name}</p><p>{item.text}</p>
            {item.role === 'user' && <button type="button" className="voice-text-button touch-hit" disabled={!ready} onClick={() => { onTaskText(item.text); setView('tasks') }}>交给元枢</button>}
          </article>)}</div> : <div className="voice-empty"><MessageSquareText aria-hidden="true" size={28} /><p>说过的话，会出现在这里</p><span>连接后即可开始交流</span></div>}
        </> : tasks}
      </div>}
    </div>
    <footer className="voice-footer">
      {needsApproval ? <button type="button" className="voice-notice touch-hit" onClick={onClose}>执行需要进一步授权 · 结束通话并返回聊天处理</button>
        : pendingTasks > 0 ? <button type="button" className="voice-notice touch-hit" onClick={() => setView('tasks')}>{pendingTasks} 项任务等待你确认 · 点击查看</button>
          : taskNotice && view === 'call' ? <p className="voice-secondary" role="status">{taskNotice}</p> : null}
      <nav className="voice-views" aria-label="通话内容">
        <button type="button" className="touch-hit" aria-pressed={view === 'call'} onClick={() => setView('call')}><AudioLines aria-hidden="true" size={17} />通话</button>
        <button type="button" className="touch-hit" aria-pressed={view === 'transcript'} onClick={() => setView('transcript')}><MessageSquareText aria-hidden="true" size={17} />转写</button>
        <button type="button" className="touch-hit" aria-pressed={view === 'tasks'} onClick={() => setView('tasks')}><ListTodo aria-hidden="true" size={17} />任务{pendingTasks > 0 && <span className="voice-count">{pendingTasks}</span>}</button>
      </nav>
      <div className="voice-actions">
        {active ? <>
          <button type="button" className="voice-control touch-hit" disabled={!ready} aria-pressed={state.muted} onClick={onMute}>{state.muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}<span>{state.muted ? '取消静音' : '静音'}</span></button>
          <button type="button" className="voice-control voice-hangup touch-hit" onClick={onStop}><PhoneOff aria-hidden="true" /><span>{ready ? '挂断' : '取消连接'}</span></button>
          <button type="button" className="voice-control touch-hit" disabled={!ready} onClick={onInterrupt}><Square aria-hidden="true" /><span>打断回复</span></button>
        </> : <button type="button" className="voice-start touch-hit" disabled={!consented || disabled || !modelReady} onClick={() => { setView('call'); onStart() }}><Phone aria-hidden="true" size={19} />{ended ? '再次通话' : '开始通话'}</button>}
      </div>
      <p className="voice-footnote">{ready || ended ? <><Check aria-hidden="true" size={12} /><span>{ended ? '本次通话' : '通话中'} · {clock(elapsed)}</span></> : active ? '未连接就绪前，不发送麦克风音频' : disabled ? '请先结束语音输入或等待文字回复完成' : '点击开始才会申请麦克风权限'}</p>
    </footer>
  </section>
}
