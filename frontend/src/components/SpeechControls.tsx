import { Pause, Play, Square, Volume2 } from 'lucide-react'
import { useCallActive } from '../realtime/use-call-active'
import { speech, useSpeech, useSpeechOptions } from '../lib/speech'

export default function SpeechControls({ id, text, live = false }: { id: string; text: string; live?: boolean }) {
  const callActive = useCallActive()
  const options = useSpeechOptions()
  const state = useSpeech()
  const own = state.id === id
  const active = own && ['loading', 'speaking', 'paused'].includes(state.status)
  const paused = own && state.status === 'paused'
  const label = active ? paused ? '继续朗读' : state.status === 'loading' ? '准备朗读…' : '暂停朗读' : '朗读回复'
  if (live && !active && !(own && state.error)) return null
  return <span className="inline-flex flex-wrap items-center gap-1">
    {(!live || active) && <button type="button" className="message-action-button touch-hit" aria-label={label} title={label}
      disabled={callActive || (own && state.status === 'loading') || !speech.supported} onClick={() => active ? paused ? speech.resume() : speech.pause() : speech.speak(id, text)}>
      {active ? paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}<span>{active ? paused ? '继续' : state.status === 'loading' ? '准备中' : '暂停' : '朗读'}</span>
    </button>}
    {active && <button type="button" className="message-action-button touch-hit" aria-label="停止朗读" title="停止朗读" onClick={() => speech.stop()}><Square className="h-3 w-3" /><span>停止</span></button>}
    {active && options.mode === 'cloud' && <span className="text-xs text-pi-dim2">阶跃云端</span>}
    {own && state.error && <span role="status" className="text-xs text-pi-danger">{state.error}</span>}
  </span>
}
