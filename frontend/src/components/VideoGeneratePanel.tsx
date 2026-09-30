import { useState } from 'react'
import { mutate } from 'swr'
import { Film } from 'lucide-react'
import { MediaApi, withFileToken } from '../api'
import { useApp } from '../store'
import { useMediaModel } from '../hooks/useMediaModel'
import MediaHistory from './MediaHistory'
import PromptSmartFill from './PromptSmartFill'

const SECONDS = ['5', '8', '10', '12']
const SIZES = ['720P', '960P']
const FRAMES: Record<string, string> = { '16:9': '横版 16:9', '9:16': '竖版 9:16' }

export default function VideoGeneratePanel({ onGenerated, prompt: promptProp, onPromptChange, seconds, onSecondsChange, frame, onFrameChange }: {
  onGenerated?: () => void
  prompt?: string
  onPromptChange?: (value: string) => void
  seconds?: string
  onSecondsChange?: (value: string) => void
  frame?: string
  onFrameChange?: (value: string) => void
}) {
  const { models } = useApp()
  const { choices: videoModels, selection, setSelection, selectedModel, modelKey } = useMediaModel(models, 'video')
  const [size, setSize] = useState('720P')
  const [localPrompt, setLocalPrompt] = useState('')
  const [localSeconds, setLocalSeconds] = useState('10')
  const [localFrame, setLocalFrame] = useState('16:9')
  const prompt = promptProp ?? localPrompt
  const setPrompt = onPromptChange ?? setLocalPrompt
  const sec = seconds ?? localSeconds
  const setSec = onSecondsChange ?? setLocalSeconds
  const aspect = frame ?? localFrame
  const setAspect = onFrameChange ?? setLocalFrame
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const gen = async () => {
    if (busy || !prompt.trim() || !selectedModel) return
    setBusy(true); setErr(''); setResult(null); setPhase('排队中…')
    try {
      const m = selectedModel
      const start = await MediaApi.video({
        provider: m.provider,
        modelId: m.id,
        prompt: prompt.trim(),
        seconds: sec,
        size,
        aspect_ratio: aspect,
        mode: 'text',
      })
      if (start.video) { setResult(start.video); onGenerated?.(); mutate('artifacts'); return }
      const taskId = start.task_id
      if (!taskId) { setErr(start.error || '未返回任务号'); return }
      for (let i = 0; i < 48; i++) {
        setPhase(`出片中… 已等 ${(i + 1) * 5} 秒`)
        await new Promise(r => setTimeout(r, 5000))
        const p = await MediaApi.video({ provider: m.provider, modelId: m.id, task_id: taskId, prompt: prompt.trim() })
        if (p.video) { setResult(p.video); onGenerated?.(); mutate('artifacts'); return }
        if (p.error && p.status !== 'pending') { setErr(p.error); return }
      }
      setErr('出片超时（约 4 分钟）。任务可能还在排队，可稍后到生成物/视频看。')
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally { setBusy(false); setPhase('') }
  }

  return (
    <div className="panel !p-3 mb-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-pi-text inline-flex items-center gap-1.5"><Film className="w-4 h-4" /> 生成视频</span>
        <span className="hidden sm:inline text-[11px] text-pi-dim2">生成后自动存入「生成物/视频」</span>
      </div>
      <MediaHistory kind="video" onPick={a => { if (a.prompt) setPrompt(a.prompt); setResult(a.url); setErr('') }} />
      {videoModels.length === 0 ? (
        <div className="text-xs text-pi-dim2 py-2">没有可用的视频模型——先到模型管理里添加（如 Agnes Video）</div>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <select aria-label="视频模型" disabled={busy} className="input-pi min-h-11 !py-2 text-xs w-full sm:max-w-[260px]" value={selectedModel ? selection : ''}
              onChange={e => setSelection(e.target.value)}>
              {!selectedModel && <option value="" disabled>所选模型已不可用，请重新选择</option>}
              {videoModels.map(m => (
                <option key={modelKey(m)} value={modelKey(m)}>
                  {m.name}（{m.provider}）{m.free ? ' · 免费' : ''}
                </option>
              ))}
            </select>
            <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-28" value={sec} onChange={e => setSec(e.target.value)}>
              {SECONDS.map(s => <option key={s} value={s}>{s} 秒</option>)}
            </select>
            <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-28" value={size} onChange={e => setSize(e.target.value)}>
              {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-32" value={aspect} onChange={e => setAspect(e.target.value)}>
              {Object.entries(FRAMES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          <textarea className="input-pi text-[13px] resize-none min-h-[88px]" rows={4}
            placeholder="描述想要的镜头：谁、在哪、做什么。写一句也可以，点智能填充再出片"
            value={prompt} onChange={e => setPrompt(e.target.value)} />
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <button className="btn-primary text-xs px-4 min-h-11 w-full sm:w-auto disabled:opacity-60" onClick={gen} disabled={busy || !prompt.trim() || !selectedModel}>
              {busy ? (phase || '出片中…') : '生成'}
            </button>
            <PromptSmartFill kind="video" idea={prompt} onFilled={({ prompt: next }) => setPrompt(next)} />
            {err && <span role="alert" className="text-xs text-pi-red break-words">{err}</span>}
          </div>
          {result && (
            <div className="space-y-2 pt-1">
              <video controls playsInline src={withFileToken(result)} className="w-full max-w-[560px] aspect-video rounded-pi-lg border border-pi-border-soft bg-black" />
              <a className="text-xs text-pi-accent hover:underline" href={withFileToken(result)} target="_blank" rel="noreferrer">新窗口查看 ↗</a>
            </div>
          )}
        </>
      )}
    </div>
  )
}
