import { useId } from 'react'
import { ExternalLink } from 'lucide-react'
import { speech, setAutoSpeech } from '../lib/speech'
import { voiceLabUrl } from '../lib/voice-lab-entry.mjs'

export default function VoiceLabEntry({ busy }: { busy: boolean }) {
  const descriptionId = useId()
  const url = voiceLabUrl(window.location.origin)
  if (!url) return null
  return <div className="flex flex-wrap items-center gap-x-3 text-sm text-pi-text">
    <a href={busy ? undefined : url} target="_blank" rel="noopener noreferrer" aria-describedby={descriptionId}
      aria-disabled={busy} tabIndex={busy ? -1 : 0}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded px-1 underline underline-offset-4 ${busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-pi-bg-hover'}`}
      onClick={event => {
        if (busy) { event.preventDefault(); return }
        speech.stop()
        setAutoSpeech(false)
      }}>
      实时语音 · 本机试用<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
    <span id={descriptionId} className="min-w-0 break-words">
      {busy ? '先结束录音或等待语音处理完成。' : '新标签页打开独立测试会话，不会带入当前聊天；打开时关闭本页自动朗读。'}
    </span>
  </div>
}
