import { Film, Image, MessagesSquare, Mic } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Model } from '../../types'
import { effectiveCapabilities, isTextModel, isChatSelectable } from '../../../../shared/model-capabilities.mjs'

export type ModelCardProps = {
  model: Model
  active: boolean
  switching: boolean
  onUse: () => void
  onVerify?: () => void
  verifying?: boolean
  busy?: boolean
}

function capabilityKeys(model: Model): string[] {
  return Object.entries(effectiveCapabilities(model)).filter(([, enabled]) => enabled).map(([key]) => key)
}

function capabilityIcon(model: Model): LucideIcon {
  const keys = capabilityKeys(model)
  if (keys.includes('image')) return Image
  if (keys.includes('video')) return Film
  if (keys.includes('tts') || keys.includes('asr') || keys.includes('realtime')) return Mic
  return MessagesSquare
}

export default function ModelCard({ model, active, switching, onUse, onVerify, verifying, busy }: ModelCardProps) {
  const CapabilityIcon = capabilityIcon(model)
  const textModel = isTextModel(model), keys = capabilityKeys(model)
  const chatSelectable = isChatSelectable(model)
  const category = [['chat', '对话'], ['image', '绘图'], ['video', '视频'], ['tts', '朗读'], ['asr', '识别'], ['realtime', '实时通话']].filter(([key]) => keys.includes(key)).map(([, label]) => label).join(' · ')
  const free = model.free || (model.note || '').includes('免费')
  const vision = model.vision || model.capabilities?.vision === true
  const verification = model.verification
  const context = model.limitsSource !== 'default' && model.contextWindow
    ? model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1000)}K` : String(model.contextWindow)
    : ''

  return (
    <article className={`panel !p-3.5 flex flex-col gap-2.5 card-hover overflow-hidden ${active ? '!border-pi-accent/50 ring-1 ring-pi-accent/30' : ''}`}>
      <div className="flex items-start gap-2.5 min-w-0">
        <span className={`w-8 h-8 rounded-pi-md flex items-center justify-center flex-shrink-0 ${active ? 'bg-pi-accent/15 text-pi-accent' : 'bg-pi-default text-pi-dim'}`}>
          <CapabilityIcon className="w-4 h-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-[13px] text-pi-text truncate flex-1">{model.name}</h3>
            {active && <span className="text-[10px] text-pi-success flex-shrink-0">使用中</span>}
          </div>
          <p className="mt-0.5 text-[11px] text-pi-dim2 font-mono truncate">{model.provider}/{model.id}</p>
        </div>
      </div>

      <div className="flex min-h-5 items-center gap-1.5 flex-wrap text-[10px]">
        <span className="text-sm text-pi-dim">{category || '能力待确认'}</span>
        {free && <span className="px-1.5 py-0.5 rounded-pi-pill border border-pi-success/30 bg-pi-success/10 text-pi-success">免费</span>}
        {model.reasoning && <span className="px-1.5 py-0.5 rounded-pi-pill border border-pi-accent/25 bg-pi-accent/10 text-pi-accent">推理</span>}
        {vision && <span className="px-1.5 py-0.5 rounded-pi-pill border border-pi-accent/25 bg-pi-accent/10 text-pi-accent">视觉</span>}
        {context && <span className="px-1.5 py-0.5 rounded-pi-pill bg-pi-default text-pi-dim2">上下文 {context}</span>}
      </div>

      {model.note && <p className="text-[12px] text-pi-dim2 truncate" title={model.note}>{model.note}</p>}
      <div className="text-sm space-y-1 text-pi-dim" role="status">
        {model.api && <p>{model.api === 'anthropic-messages' ? 'Anthropic Messages' : model.api === 'openai-responses' ? 'OpenAI Responses' : model.api === 'openai-completions' ? 'OpenAI Chat' : model.api}</p>}
        <p className={verification?.ok ? 'text-pi-success' : verification?.status === 'failed' ? 'text-pi-danger' : ''}>{verifying ? '正在验证文本…' : verification ? verification.ok ? '文本验证通过' : verification.status === 'inconclusive' ? '尚未确认完整回答' : '上次验证失败' : '尚未验证'}</p>
        {verification && <><p className="break-words">{verification.message}</p><p>{new Date(verification.checkedAt).toLocaleString()}</p></>}
        {verification?.reportedModel && verification.reportedModel !== model.id && <p className="break-all">上游报告模型：{verification.reportedModel}</p>}
        {model.capabilitySource === 'inferred' && <p>能力按名称推断，尚未实测</p>}
      </div>

      {onVerify && <button className="btn-tool touch-hit text-sm" disabled={busy || !textModel} onClick={onVerify}>{!textModel ? '媒体模型：请在对应工具验证' : verifying ? '验证中…' : '验证文本'}</button>}
      <button onClick={onUse} disabled={active || busy || switching || !chatSelectable}
        className={`mt-auto touch-hit text-sm rounded-pi-md py-1.5 transition-colors duration-150 ${active ? 'bg-pi-default text-pi-dim2 cursor-default' : 'accent-soft text-pi-accent hover:brightness-110'}`}>
        {!chatSelectable ? '请在语音入口选择' : active ? '当前使用' : switching ? '切换中…' : '切换使用'}
      </button>
    </article>
  )
}
