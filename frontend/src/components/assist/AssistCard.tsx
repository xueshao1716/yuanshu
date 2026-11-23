import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Mic, Send, X, Loader2 } from 'lucide-react'
import { AsrApi } from '../../api'
import { createVoiceRecorder, microphonePreflight, microphoneError } from '../../lib/voice-recorder.mjs'
import { blobToWavBase64 } from '../../lib/wav.mjs'
import { CHOICE_EVENT } from '../../lib/choice-reply.mjs'
import './assist-card.css'

/**
 * 2026-11-23 轻量卡片「问小语」。
 * 通知栏磁贴 / 桌面卡片 / 长按图标 / 系统助理唤起后，先弹这张底部卡片：
 * 一个麦克风 + 一行输入，不加载整个对话页。发送后自动切到 #/chat 并把话递过去。
 * 为什么不用 RealtimeCall：那是实时语音通话，要开 WebSocket、占音频焦点，冷启动也慢；
 * 这张卡只做一件事——最快把一句话交出去。
 */
export default function AssistCard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const recRef = useRef<ReturnType<typeof createVoiceRecorder> | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const reqRef = useRef(0)

  useEffect(() => {
    if (!open) return
    setText(''); setError(''); setSeconds(0)
    setTranscribing(false)
    const t = setTimeout(() => taRef.current?.focus(), 120)
    return () => clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    const controller = createVoiceRecorder({
      getUserMedia: (o: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(o),
      Recorder: window.MediaRecorder,
      onState: s => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
        setRequesting(s === 'requesting')
        setRecording(s === 'recording')
        if (s === 'recording') { setSeconds(0); timerRef.current = setInterval(() => setSeconds(v => v + 1), 1000) }
      },
      onError: m => setError(m),
      onData: async blob => {
        const req = ++reqRef.current
        setTranscribing(true); setError('')
        try {
          const b64 = await blobToWavBase64(blob)
          const r = await AsrApi.transcribe(b64, 'wav')
          if (req !== reqRef.current) return
          if (!r.text) throw new Error('没听清，再说一次？')
          setText(v => (v ? v + ' ' : '') + r.text)
          taRef.current?.focus()
        } catch (e: any) {
          if (req === reqRef.current) setError(`语音识别失败：${e?.message || e}`)
        } finally { if (req === reqRef.current) setTranscribing(false) }
      },
    })
    recRef.current = controller
    return () => { controller.stop(true); recRef.current = null; if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  useEffect(() => { if (recording && seconds >= 60) recRef.current?.stop() }, [recording, seconds])

  const toggleMic = () => {
    if (transcribing) return
    if (recording || requesting) { recRef.current?.stop(); return }
    const policy = (document as any).permissionsPolicy || (document as any).featurePolicy
    const err = microphonePreflight({
      secure: window.isSecureContext,
      allowed: policy?.allowsFeature?.('microphone') !== false,
      media: !!navigator.mediaDevices?.getUserMedia,
      recorder: !!window.MediaRecorder,
    })
    setError(err)
    if (!err) recRef.current?.start()
  }

  const send = () => {
    const t = text.trim()
    if (!t) return
    recRef.current?.stop(true)
    const wasChat = location.hash.startsWith('#/chat')
    onClose()
    // 卡片可能在任意页面弹出；先切到对话页，等 ChatArea 的监听挂上再递话
    if (!wasChat) location.hash = '#/chat'
    setTimeout(() => {
      try { window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { text: t } })) } catch {}
    }, wasChat ? 60 : 450)
  }

  if (!open) return null
  const busy = requesting || transcribing
  // 挂到 body 上：AppLayout 根节点可能形成层叠上下文，卡片留在里面会被陪伴小人的状态条压住
  return createPortal(
    <div className="ys-assist-root" role="dialog" aria-modal="true" aria-label="问小语">
      <div className="ys-assist-scrim" onClick={onClose} />
      <div className="ys-assist-sheet">
        <div className="ys-assist-head">
          <span className="ys-assist-title">问小语</span>
          <button className="ys-assist-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <textarea
          ref={taRef}
          className="ys-assist-input"
          rows={2}
          value={text}
          placeholder="直接问我，或者按麦克风说一句"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }}
        />
        {(recording || busy) && (
          <div className="ys-assist-rec">
            <span className="ys-assist-dot" />
            {recording ? `正在听… ${seconds}s（点一下结束）` : requesting ? '正在打开麦克风…' : '正在识别…'}
          </div>
        )}
        {error && <div className="ys-assist-err">{error}</div>}
        <div className="ys-assist-actions">
          <button
            type="button"
            className={`ys-assist-mic${recording ? ' on' : ''}`}
            onClick={toggleMic}
            disabled={transcribing}
            aria-label={recording ? '结束录音' : '按住说话'}
            title={recording ? '点一下结束' : '语音输入'}
          >
            {busy && !recording ? <Loader2 size={22} className="ys-spin" /> : <Mic size={22} />}
          </button>
          <button type="button" className="ys-assist-send" onClick={send} disabled={!text.trim()} aria-label="发送">
            <Send size={18} />
            <span>发送</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
