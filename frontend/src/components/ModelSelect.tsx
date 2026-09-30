import { useRef, useState } from 'react'
import { useApp } from '../store'
import { KeysApi } from '../api'
import * as DM from '@radix-ui/react-dropdown-menu'
import { ChevronDown, Zap, Paintbrush, Video, Mic2, Cpu } from 'lucide-react'
import { toast } from './Toast'
import type { Model } from '../types'
import { effectiveCapabilities, isChatSelectable } from '../../../shared/model-capabilities.mjs'

function capIcon(m: Model) {
  const cap = effectiveCapabilities(m)
  const keys: string[] = Array.isArray(cap) ? cap : Object.entries(cap || {}).filter(([, v]) => v).map(([k]) => k as string)
  if (keys.includes('image')) return <Paintbrush className="w-3.5 h-3.5 text-pink-400" strokeWidth={1.8} />
  if (keys.includes('video')) return <Video className="w-3.5 h-3.5 text-amber-400" strokeWidth={1.8} />
  if (keys.includes('tts') || keys.includes('asr') || keys.includes('realtime')) return <Mic2 className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.8} />
  return <Cpu className="w-3.5 h-3.5 text-pi-accent2" strokeWidth={1.8} />
}

export function modelLabel(m: Model): string {
  const cap = effectiveCapabilities(m)
  const keys: string[] = Array.isArray(cap) ? cap : Object.entries(cap || {}).filter(([, v]) => v).map(([k]) => k as string)
  const tag = keys.includes('image') ? '[绘图] ' : keys.includes('video') ? '[视频] ' : (keys.includes('tts') || keys.includes('asr') || keys.includes('realtime')) ? '[语音] ' : ''
  const free = m.free || (m.note || '').includes('免费')
  return `${tag}${m.name}（${m.provider}）${free ? ' · 免费' : ''}`
}

// item 视觉契约：高亮态由 Radix data-highlighted / data-state=checked 驱动
const ITEM_CLS = 'outline-none flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors data-[disabled]:opacity-60 data-[disabled]:cursor-not-allowed data-[highlighted]:bg-pi-bg-hover data-[state=checked]:bg-pi-accent/12'

export default function ModelSelect({ compact = false, zClass = 'z-50', side = 'top' }: { compact?: boolean; zClass?: string; side?: 'top' | 'bottom' }) {
  const { models, currentModel, setCurrentModel, currentSessionId } = useApp()
  const switchingRef = useRef(false)
  const [switching, setSwitching] = useState(false)

  const isAuto = currentModel === 'auto/auto'
  const currentLabel = isAuto ? 'Auto' : (() => {
    const idx = currentModel.indexOf('/')
    const m = models.find(x => x.provider === currentModel.slice(0, idx) && x.id === currentModel.slice(idx + 1))
    return m ? m.name : currentModel
  })()

  const select = async (mk: string) => {
    if (switchingRef.current) return
    switchingRef.current = true; setSwitching(true)
    const prev = currentModel
    setCurrentModel(mk)
    const idx = mk.indexOf('/')
    try {
      await KeysApi.switchModel({ provider: mk.slice(0, idx), modelId: mk.slice(idx + 1), sessionId: currentSessionId ?? undefined })
      toast('模型已切换', 'ok')
    } catch (e: any) {
      // 失败回滚乐观更新，不再静默吞错
      setCurrentModel(prev)
      toast(`模型切换失败：${e?.message || '未知错误'}`, 'error')
    } finally { switchingRef.current = false; setSwitching(false) }
  }

  return (
    <DM.Root>
      <DM.Trigger asChild>
        <button
          data-slot="model-trigger"
          aria-label="选择模型"
          disabled={switching}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-pi-md border border-pi-border-soft bg-pi-bg2/50 text-[12px] text-pi-dim hover:text-pi-text glow-hover duration-200 data-[state=open]:border-pi-accent/40 ${compact ? 'max-w-[110px]' : 'max-w-[160px]'}`}
        >
          <Zap className="w-3 h-3 text-pi-accent flex-shrink-0" strokeWidth={2} />
          <span className="truncate font-medium">{currentLabel}</span>
          <ChevronDown className={`w-3 h-3 text-pi-dim2 flex-shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180`} strokeWidth={2} />
        </button>
      </DM.Trigger>

      <DM.Portal>
        <DM.Content data-slot="model-listbox" side={side} align="start" sideOffset={6}
          className={`w-72 max-h-80 overflow-y-auto rounded-pi-lg border border-pi-border bg-pi-bg1/95 shadow-2xl ${zClass}`}
          style={{ animationDuration: '0.15s' }}>
          <DM.RadioGroup value={currentModel} onValueChange={select}>
            {/* Auto */}
            <DM.RadioItem value="auto/auto" className={ITEM_CLS}>
              <Zap className={`w-4 h-4 flex-shrink-0 ${isAuto ? 'text-pi-accent' : ''}`} strokeWidth={2} />
              <div className="flex-1 min-w-0">
                <div className={`text-[13px] font-semibold ${isAuto ? 'text-pi-accent' : 'text-pi-text'}`}>Auto 智能路由</div>
                <div className="text-[11px] opacity-60">按任务复杂度自动选模型</div>
              </div>
              {isAuto && <span className="text-[10px] px-1.5 py-0.5 rounded-pi-sm bg-pi-accent/20 text-pi-accent font-medium">当前</span>}
            </DM.RadioItem>
            <DM.Separator className="mx-3 my-0.5 border-t border-pi-border-soft" />
            {models.map(m => {
              const mk = `${m.provider}/${m.id}`
              const active = currentModel === mk
              const free = m.free || (m.note || '').includes('免费')
              return (
                <DM.RadioItem key={mk} value={mk} disabled={switching || !isChatSelectable(m)} data-slot="model-option" className={ITEM_CLS}>
                  <div className="flex-shrink-0">{capIcon(m)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[13px] font-medium truncate ${active ? 'text-pi-accent' : 'text-pi-text'}`}>{m.name}</span>
                      {free && <span className="text-[10px] px-1 py-px rounded-pi-sm bg-emerald-500/15 text-emerald-400 font-medium flex-shrink-0">免费</span>}
                    </div>
                    <div className="text-[11px] text-pi-dim2 truncate">{m.provider}{!isChatSelectable(m) ? ' · 请在语音入口选择' : ''}</div>
                  </div>
                  {active && <span className="text-[10px] px-1.5 py-0.5 rounded-pi-sm bg-pi-accent/20 text-pi-accent font-medium flex-shrink-0">当前</span>}
                </DM.RadioItem>
              )
            })}
          </DM.RadioGroup>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  )
}
