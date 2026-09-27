import { Pause, Play, Square, Volume2 } from 'lucide-react'
import { speech, useSpeech, useAutoSpeech, setAutoSpeech } from '../lib/speech'

export default function SpeechControls({ id, text }: { id: string; text: string }) {
  const state = useSpeech()
  const own = state.id === id
  const active = own && ['loading', 'speaking', 'paused'].includes(state.status)
  const paused = own && state.status === 'paused'
  const label = active ? paused ? '继续朗读' : state.status === 'loading' ? '准备朗读…' : '暂停朗读' : '朗读回复'
  return <span className="inline-flex flex-wrap items-center gap-1">
    <button type="button" className="message-action-button touch-hit" aria-label={label} title={label}
      disabled={own && state.status === 'loading'} onClick={() => active ? paused ? speech.resume() : speech.pause() : speech.speak(id, text)}>
      {active ? paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}<span>{active ? paused ? '继续' : state.status === 'loading' ? '准备中' : '暂停' : '朗读'}</span>
    </button>
    {active && <button type="button" className="message-action-button touch-hit" aria-label="停止朗读" title="停止朗读" onClick={() => speech.stop()}><Square className="h-3 w-3" /><span>停止</span></button>}
    {own && state.error && <span role="status" className="text-xs text-pi-danger">{state.error}</span>}
  </span>
}

export function SpeechPreference() {
  const enabled = useAutoSpeech()
  const state = useSpeech()
  return <div className="flex flex-wrap items-center gap-x-3 text-xs text-pi-dim2">
    <button type="button" role="switch" aria-checked={enabled} aria-label="自动朗读新回复" disabled={!speech.supported}
      title="系统朗读；仅本次打开页面有效，不读取历史回复" className="touch-hit inline-flex items-center gap-1.5"
      onClick={() => setAutoSpeech(!enabled)}><Volume2 className="h-3.5 w-3.5" />自动朗读：{enabled ? '开' : '关'}</button>
    {!speech.supported && <span>此设备暂不支持系统朗读</span>}
    {enabled && state.error && <span role="status" className="text-pi-danger">{state.error}</span>}
  </div>
}
