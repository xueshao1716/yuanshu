import { useState } from 'react'
import { mutate } from 'swr'
import { ImagePlus, X } from 'lucide-react'
import { MediaApi, withFileToken } from '../api'
import { useApp } from '../store'
import { useMediaModel } from '../hooks/useMediaModel'
import MediaHistory from './MediaHistory'
import PromptSmartFill from './PromptSmartFill'

// ── 出图面板：选模型/尺寸 → 生成 → 服务端自动落盘 生成物/图片/日期 → 资产库刷新 ──

const SIZE_OPTIONS = ['1024x1024', '832x1472', '1472x832']
const SIZE_LABEL: Record<string, string> = { '1024x1024': '方形 1:1', '832x1472': '竖版 9:16', '1472x832': '横版 16:9' }

export default function GeneratePanel({ onClose, onGenerated, prompt: promptProp, onPromptChange }: {
  onClose?: () => void
  onGenerated: () => void
  prompt?: string
  onPromptChange?: (value: string) => void
}) {
  const { models } = useApp()
  const { choices: imageModels, selection, setSelection, selectedModel, modelKey } = useMediaModel(models, 'image')
  const [size, setSize] = useState('1024x1024')
  const [localPrompt, setLocalPrompt] = useState('')
  const prompt = promptProp ?? localPrompt
  const setPrompt = onPromptChange ?? setLocalPrompt
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const gen = async () => {
    if (busy || !prompt.trim() || !selectedModel) return
    setBusy(true); setErr(''); setResult(null)
    try {
      const m = selectedModel
      const r = await MediaApi.image({ provider: m.provider, modelId: m.id, prompt: prompt.trim(), size })
      if (r.image) { setResult(r.image); onGenerated(); mutate('artifacts') }
      else setErr(r.error || '未返回图片')
    } catch (e: any) {
      // api.ts 已把对象型 error 转成可读字符串
      setErr(e?.message || String(e))
    } finally { setBusy(false) }
  }

  return (
    <div className="panel !p-3 mb-4 space-y-3">
          <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-pi-text inline-flex items-center gap-1.5"><ImagePlus className="w-4 h-4" /> 生成图片</span>
        <span className="hidden sm:inline text-[11px] text-pi-dim2">生成后自动存入「生成物/图片」</span>
        {onClose && <button className="btn-tool !px-2 ml-auto" onClick={onClose}><X className="w-4 h-4" /></button>}
      </div>
      <MediaHistory kind="image" onPick={a => { if (a.prompt) setPrompt(a.prompt); setResult(a.url); setErr('') }} />
      {imageModels.length === 0 ? (
        <div className="text-xs text-pi-dim2 py-2">没有可用的图像模型——先到模型管理里添加（如 Agnes / 云flare Flux / 豆包 Seedream）</div>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-2">
            <select aria-label="绘图模型" disabled={busy} className="input-pi min-h-11 !py-2 text-xs w-full sm:max-w-[260px]" value={selectedModel ? selection : ''}
              onChange={e => setSelection(e.target.value)}>
              {!selectedModel && <option value="" disabled>所选模型已不可用，请重新选择</option>}
              {imageModels.map(m => (
                <option key={modelKey(m)} value={modelKey(m)}>
                  {m.name}（{m.provider}）{m.free ? ' · 免费' : ''}
                </option>
              ))}
            </select>
            <select className="input-pi min-h-11 !py-2 text-xs w-full sm:w-36" value={size} onChange={e => setSize(e.target.value)}>
              {SIZE_OPTIONS.map(s => <option key={s} value={s}>{SIZE_LABEL[s]}</option>)}
            </select>
          </div>
          <textarea className="input-pi text-[13px] resize-none min-h-[88px]" rows={3}
            placeholder="描述想要的画面… 写一句也可以，点智能填充再出图"
            value={prompt} onChange={e => setPrompt(e.target.value)} />
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <button className="btn-primary text-xs px-4 min-h-11 w-full sm:w-auto disabled:opacity-60" onClick={gen} disabled={busy || !prompt.trim() || !selectedModel}>
              {busy ? '生成中…（图像模型较慢，可能 30-120s）' : '生成'}
            </button>
            <PromptSmartFill kind="image" idea={prompt} onFilled={({ prompt: next }) => setPrompt(next)} />
            {err && <span role="alert" className="text-xs text-pi-red break-words">{err}</span>}
          </div>
          {result && (
            <div className="flex items-start gap-3 pt-1">
              <img src={withFileToken(result)} alt="生成结果" className="max-w-[240px] max-h-[240px] rounded-pi-lg border border-pi-border object-cover cursor-zoom-in"
                onClick={() => window.open(withFileToken(result), '_blank')} />
              <a className="text-xs text-pi-accent hover:underline mt-1" href={withFileToken(result)} target="_blank" rel="noreferrer">新窗口查看 ↗</a>
            </div>
          )}
        </>
      )}
    </div>
  )
}
