import { useEffect, useRef, useState } from 'react'
import { Mic, Paperclip, FileText, SlidersHorizontal } from 'lucide-react'
import ParamsPanel from './ParamsPanel'
import { WsApi } from '../api'
import ModelSelect from './ModelSelect'

const SLASH_COMMANDS = [
  { cmd: '/new', desc: '新建会话' },
  { cmd: '/legacy', desc: '切换到旧版界面' },
  { cmd: '/compact', desc: '压缩上下文（省 token）' },
  { cmd: '/stats', desc: '查看统计' },
  { cmd: '/help', desc: '显示所有命令' },
]

export interface FileAttachment { path: string; content: string }

interface Props {
  streaming: boolean
  onStop: () => void
  onSend: (text: string, files: FileAttachment[]) => void
  onCommand?: (cmd: string) => void
  onVoice?: (dataB64: string, format: string) => void
  voiceBusy?: boolean
  onVoiceTextReady?: (fn: (t: string) => void) => void
  /** 当前会话：上传必须带上它，否则文件会被挂到别的会话上（真机 bug：传上去聊天里不显示） */
  sessionId?: string | null
  /**
   * 会话还没就绪时向宿主索要一个真实会话 id（新建+切过去并返回）。
   * 真机复现（2026-09-18）：点「新建对话」后立刻传文件，`currentSessionId` 还没落地（列表刷新
   * 还在路上）→ 上传不带 sessionId → 服务端只能猜 → 卡片落到别的会话 → "传上去了但看不见"。
   */
  ensureSession?: () => Promise<string | null>
  /** 上传成功后通知外层刷新消息列表，让文件卡片立刻出现在对话里；参数是服务端回执 */
  onUploaded?: (r: { attachedTo?: string | null; guessedSession?: boolean }) => void
}

async function blobToWavBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const AC = window.AudioContext || (window as any).webkitAudioContext
  const ctx = new AC()
  let audio: AudioBuffer
  try { audio = await ctx.decodeAudioData(buf) } finally { ctx.close().catch(() => {}) }
  const TARGET_RATE = 16000
  const chCount = Math.min(audio.numberOfChannels, 2)
  const ratio = audio.sampleRate / TARGET_RATE
  const outLen = Math.floor(audio.length / ratio)
  const out = new Float32Array(outLen)
  const chans: Float32Array[] = []
  for (let c = 0; c < chCount; c++) chans.push(audio.getChannelData(c))
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio
    const i0 = Math.floor(srcIdx), frac = srcIdx - i0
    const i1 = Math.min(i0 + 1, audio.length - 1)
    let sum = 0
    for (let c = 0; c < chCount; c++) sum += chans[c][i0] * (1 - frac) + chans[c][i1] * frac
    out[i] = sum / chCount
  }
  const dataLen = out.length * 2
  const view = new DataView(new ArrayBuffer(44 + dataLen))
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE')
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true); view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  ws(36, 'data'); view.setUint32(40, dataLen, true)
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let bin = ''; const bytes = new Uint8Array(view.buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

export default function SendBox({ streaming, onStop, onSend, onCommand, onVoice, voiceBusy, onVoiceTextReady, sessionId, ensureSession, onUploaded }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [slashQuery, setSlashQuery] = useState<string | null>(null)
  const [slashHi, setSlashHi] = useState(0)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atHi, setAtHi] = useState(0)
  const [atResults, setAtResults] = useState<{ name: string; path: string }[]>([])
  const [micErr, setMicErr] = useState('')
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; mime: string } | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    onVoiceTextReady?.((t) => setValue(v => (v ? v + ' ' : '') + t))
  }, [onVoiceTextReady])

  const pickMime = (): string => {
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    for (const mime of cands) {
      try { if ((window as any).MediaRecorder?.isTypeSupported?.(mime)) return mime } catch {}
    }
    return ''
  }

  const startRec = async () => {
    if (!onVoice || recording || voiceBusy) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks: Blob[] = []
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      rec.onerror = () => stopRec(true)
      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' })
        if (blob.size > 800 && onVoice) {
          ;(async () => {
            try {
              const b64 = await blobToWavBase64(blob)
              onVoice(b64, 'wav')
            } catch {}
          })()
        }
        recRef.current = null
      }
      rec.start()
      recRef.current = { rec, stream, chunks, mime }
      setRecording(true); setRecSeconds(0)
      recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000)
    } catch {
      setMicErr('无法访问麦克风，请检查浏览器权限')
      setTimeout(() => setMicErr(''), 4000)
    }
  }

  const stopRec = (cancel = false) => {
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
    const r = recRef.current
    if (!r) { setRecording(false); return }
    if (cancel) r.rec.onstop = null as any
    setRecording(false)
    try { r.rec.stop() } catch {}
  }

  const slashMatches = slashQuery !== null
    ? SLASH_COMMANDS.filter(c => c.cmd.startsWith(slashQuery.toLowerCase()))
    : []
  const showSlash = slashMatches.length > 0

  // 高亮索引跟随过滤结果重置（08-25：菜单键盘导航）
  useEffect(() => { setSlashHi(0) }, [slashQuery])

  useEffect(() => {
    if (atQuery === null) return
    const kw = atQuery.trim()
    if (kw.length < 1) { setAtResults([]); return }
    const t = setTimeout(async () => {
      try {
        const d = await WsApi.search(kw)
        let items = (d.results || []).slice(0, 6)
        if (!items.length) {
          try { const t = await WsApi.tree(''); items = (t.items || []).filter(i => i.type === 'file').slice(0, 6).map(i => ({ name: i.name, path: i.path })) } catch {}
        }
        setAtResults(items)
      } catch { setAtResults([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [atQuery])
  useEffect(() => { setAtHi(0) }, [atQuery, atResults.length])
  const showAt = atQuery !== null

  const onChange = (v: string) => {
    setValue(v)
    const before = v.slice(0, v.length)
    const slashM = before.match(/(?:^|\n)\/([a-z]*)$/i)
    const atM = before.match(/@([^\s@]*)$/)
    setSlashQuery(slashM ? '/' + slashM[1] : null)
    setAtQuery(atM ? atM[1] : null)
  }

  const pickSlash = (cmd: string) => {
    setValue(''); setSlashQuery(null)
    onCommand?.(cmd)
  }
  const pickAt = async (r: { path: string }) => {
    setValue(v => v.replace(/@[^\s@]*$/, ''))
    setAtQuery(null)
    if (files.some(f => f.path === r.path)) return
    try { const d = await WsApi.read(r.path); setFiles(prev => [...prev, { path: r.path, content: d.content || '' }]) } catch {}
  }

  const doSend = () => {
    const v = value.trim()
    if (!v || streaming) return
    onSend(v, files)
    setValue(''); setFiles([]); setSlashQuery(null); setAtQuery(null)
  }

  const onUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    setUploading(true)
    try {
      const buf = await f.arrayBuffer()
      let bin = ''; const bytes = new Uint8Array(buf)
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      // 会话 id 必须真实：state 里还没有就问宿主要一个（新建+选中），绝不发空 id 让服务端猜
      let sid = sessionId || null
      if (!sid && ensureSession) { try { sid = await ensureSession() } catch {} }
      const d = await WsApi.upload(f.name, btoa(bin), sid || undefined)
      if (d.path) {
        const rd = await WsApi.read(d.path)
        setFiles(prev => [...prev, { path: d.path!, content: rd.content || '' }])
        // 服务端刚往这个会话追加了一条带 file 的消息 → 让外层立刻刷新，卡片才会出现在对话里
        try { onUploaded?.({ attachedTo: d.attachedTo ?? d.sessionId ?? null, guessedSession: !!d.guessedSession }) } catch {}
      }
    } catch {} finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  return (
    <div className="relative">
      {/* 麦克风错误提示*/}
      {micErr && <div className="mb-1.5 px-3 py-1.5 rounded-xl bg-pi-red/12 border border-pi-red/30 text-[12px] text-pi-red" role="alert">⚠ {micErr}</div>}
      {/* 斜杠命令菜单 */}
      {showSlash && (
        <div className="absolute bottom-full left-0 right-0 mb-1 panel !p-1 max-h-56 overflow-y-auto z-20" role="listbox" aria-label="斜杠命令">
          {slashMatches.map((c, i) => (
            <div key={c.cmd} role="option" aria-selected={i === slashHi}
              className={`px-3 py-2 rounded-pi-sm cursor-pointer flex items-baseline gap-2 ${i === slashHi ? 'bg-pi-bg3' : 'hover:bg-pi-bg-hover'}`}
              onMouseEnter={() => setSlashHi(i)}
              onMouseDown={e => { e.preventDefault(); pickSlash(c.cmd) }}>
              <span className="font-mono text-[13px] text-pi-accent">{c.cmd}</span>
              <span className="text-[11px] text-pi-dim2">{c.desc}</span>
            </div>
          ))}
        </div>
      )}
      {/* @ 文件引用菜单 */}
      {showAt && (
        <div className="absolute bottom-full left-0 right-0 mb-1 panel !p-1 max-h-56 overflow-y-auto z-20" role="listbox" aria-label="引用工作空间文件">
          {atResults.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-pi-dim2">输入关键词搜索工作空间文件…</div>
          ) : atResults.map((r, i) => (
            <div key={r.path} role="option" aria-selected={i === atHi}
              className={`px-3 py-2 rounded-pi-sm cursor-pointer ${i === atHi ? 'bg-pi-bg3' : 'hover:bg-pi-bg-hover'}`}
              onMouseEnter={() => setAtHi(i)}
              onMouseDown={e => { e.preventDefault(); pickAt(r) }}>
              <div className="text-[13px] text-pi-text">{r.name}</div>
              <div className="text-[11px] text-pi-dim2 font-mono truncate">{r.path}</div>
            </div>
          ))}
        </div>
      )}

      {/* 已引用文件 chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
          {files.map(f => (
            <span key={f.path} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-pi-pill bg-pi-accent/12 border border-pi-accent/25 text-[11px] text-pi-text">
              <FileText className="w-3 h-3 flex-shrink-0" /> {f.path.split('/').pop() || f.path}
              <button className="text-pi-dim2 hover:text-pi-red ml-0.5" onClick={() => setFiles(prev => prev.filter(x => x.path !== f.path))}>✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="sendbox-shell field-container rounded-2xl transition-[background-color,border-color,box-shadow] duration-300 shadow-lg">
        <textarea ref={taRef} rows={2} value={value} disabled={streaming}
          placeholder='给小语发消息…　"/" 命令 · "@ 引用文件'
          role="combobox"
          aria-expanded={showSlash || showAt}
          aria-label="消息输入框"
          className="w-full bg-transparent border-none outline-none px-3 pt-2 pb-0.5 text-[13px] text-pi-text resize-none placeholder:text-pi-dim2 disabled:opacity-60"
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (showSlash) { pickSlash(slashMatches[slashHi] ? slashMatches[slashHi].cmd : slashMatches[0].cmd); return }
              if (showAt && atResults.length) { pickAt(atResults[atHi] || atResults[0]); return }
              doSend()
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              // 菜单打开时 ↑↓ 导航高亮项（08-25 评审 P1：菜单不再是纯鼠标组件）
              if (showSlash) {
                e.preventDefault()
                setSlashHi(h => Math.max(0, Math.min(h + (e.key === 'ArrowDown' ? 1 : -1), slashMatches.length - 1)))
              } else if (showAt && atResults.length) {
                e.preventDefault()
                setAtHi(h => Math.max(0, Math.min(h + (e.key === 'ArrowDown' ? 1 : -1), atResults.length - 1)))
              }
            } else if (e.key === 'Escape') { setSlashQuery(null); setAtQuery(null) }
          }} />

        {/* 底部操作栏：模型选择 + 工具按钮 */}
        <div className="flex items-center px-3 pb-2 gap-1">
          {/* 模型选择器（嵌入输入框） */}
          <ModelSelect compact />

          <div className="flex-1" />

          <input ref={fileInputRef} type="file" className="hidden" onChange={onUploadFile} />

          {/* 模型参数（temperature/top_p，会话级） */}
          <ParamsPanel />

          {/* 语音输入 */}
          {onVoice && !streaming && (
            recording ? (
              <button onClick={() => stopRec()}
                className="h-7 px-2.5 rounded-pi-md bg-red-500/90 text-white text-[11px] font-medium flex items-center gap-1.5 hover:bg-red-500 transition-colors"
                title="停止录音并转写">
                <span className="rec-wave"><i /><i /><i /><i /><i /></span> {Math.floor(recSeconds / 60)}:{String(recSeconds % 60).padStart(2, '0')}
              </button>
            ) : voiceBusy ? (
              <button className="btn-tool-sm" disabled title="语音识别中…">
                <span className="inline-block w-3 h-3 border-[1.5px] border-pi-accent border-t-transparent rounded-full animate-spin" /> 识别中
              </button>
            ) : (
              <button onClick={startRec} className="btn-tool-sm touch-hit" title="语音输入" aria-label="语音输入">
                <Mic className="w-4 h-4" strokeWidth={1.8} />
              </button>
            )
          )}

          {/* 附件 */}
          <button className="btn-tool-sm touch-hit" title="附加文件" aria-label="附加文件" onClick={() => fileInputRef.current?.click()} disabled={streaming || uploading}>
            {uploading ? <span className="w-4 h-4 rounded-full border-[1.5px] border-pi-accent border-t-transparent animate-spin inline-block" /> : <Paperclip className="w-4 h-4" strokeWidth={1.8} />}
          </button>

          {/* 发送 / 停止 */}
          {streaming ? (
            <button onClick={onStop}
              className="h-7 w-7 rounded-full bg-red-500/90 text-white flex items-center justify-center hover:bg-red-500 transition-colors touch-hit"
              title="停止">
              <span className="w-2.5 h-2.5 bg-white rounded-[2px]" />
            </button>
          ) : (
            <button onClick={doSend} title="发送 (Enter)"
              className="press btn-send h-7 w-7 rounded-full text-white flex items-center justify-center disabled:opacity-40 touch-hit"
              disabled={!value.trim() && files.length === 0}>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
