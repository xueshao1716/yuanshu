import { useEffect, useRef, useState } from 'react'
import { createChatCall, bindCallLifecycle } from '../realtime/call.mjs'
import { appendTranscript } from '../realtime/state.mjs'
import { audioFocus } from '../realtime/focus.mjs'
import { callSocketUrl, requestCallTicket } from '../realtime/ticket'
import { speech, setAutoSpeech } from '../lib/speech'
import workletUrl from '../realtime/capture-worklet.mjs?worker&url'
import RealtimeTasks from './RealtimeTasks'
import CallScreen, { type CallState } from './CallScreen'
import { emptyTaskState, reduceTaskState } from '../realtime/task-state.mjs'
import '../realtime/call.css'

type Props = { sessionId?: string | null; ensureSession?: () => Promise<string | null>; disabled?: boolean
  open: boolean; onClose: () => void; name?: string; needsApproval?: boolean }
type Transcript = { role: string; text: string; responseId?: string }
export default function RealtimeCall({ sessionId, ensureSession, disabled, open, onClose, name, needsApproval }: Props) {
  const [consented, setConsented] = useState(false)
  const [state, setState] = useState<CallState>({ phase: 'idle', muted: false, stage: 'idle', activity: 'idle', readyAt: null, endedAt: null, stageStartedAt: null })
  const [transcripts, setTranscripts] = useState<Transcript[]>([])
  const [taskState, setTaskState] = useState(emptyTaskState), [draft, setDraft] = useState('')
  const ownsAudio = useRef(false), mounted = useRef(true)
  const call = useRef<ReturnType<typeof createChatCall> | null>(null)
  if (!call.current) call.current = createChatCall({ wsUrl: callSocketUrl(), requestTicket: requestCallTicket, workletUrl,
    onState: next => {
      if (next.phase === 'idle' && ownsAudio.current) { ownsAudio.current = false; audioFocus.releaseCall() }
      if (mounted.current) setState(next)
      if (mounted.current && next.phase === 'idle') setTaskState(s => reduceTaskState(s, { type: 'task.disconnected' }))
    },
    onEvent: event => {
      if (!mounted.current) return
      if (event.type === 'transcript') setTranscripts(list => appendTranscript(list, event))
      if (event.type?.startsWith('task.')) setTaskState(s => reduceTaskState(s, event))
    },
  })
  useEffect(() => {
    mounted.current = true
    const dispose = bindCallLifecycle(call.current)
    return () => { mounted.current = false; dispose() }
  }, [])
  useEffect(() => { call.current?.sessionChanged(sessionId || null); setTranscripts([]); setTaskState(emptyTaskState()); setDraft('') }, [sessionId])
  function start() {
    if (!consented || disabled || state.phase !== 'idle') return
    if (!audioFocus.acquireCall()) { setState(s => ({ ...s, error: 'call_busy' })); return }
    ownsAudio.current = true
    // 停止朗读，并关闭自动朗读；不在挂断后擅自恢复。
    speech.stop(); setAutoSpeech(false); setTranscripts([])
    void call.current?.start(sessionId || null, ensureSession)
  }
  if (!open) return null
  return <CallScreen state={state} name={name} consented={consented} setConsented={setConsented} disabled={disabled}
    transcripts={transcripts} onTaskText={setDraft} needsApproval={needsApproval}
    pendingTasks={taskState.proposals.filter(p => p.status === 'pending').length}
    taskNotice={taskState.notice} onStart={start} onMute={() => call.current?.mute()}
    onInterrupt={() => call.current?.interrupt()} onStop={() => call.current?.stop()}
    onClose={() => { call.current?.stop(); onClose() }}
    tasks={<RealtimeTasks key={sessionId || 'new'} sessionId={sessionId} ready={state.phase === 'ready'} {...taskState}
      draft={draft} setDraft={setDraft}
      propose={() => { if (call.current?.propose(crypto.randomUUID(), draft.trim())) setDraft('') }}
      confirm={(id, approved) => {
        if (call.current?.confirm(id, approved)) setTaskState(s => reduceTaskState(s, { type: 'task.submitting', id }))
      }} />} />
}
