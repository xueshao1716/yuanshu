import { useState } from 'react'
import { useApp } from '../store'
import type { Model } from '../types'
import { isTextModel } from '../../../shared/model-capabilities.mjs'

export function useWorkshopModel(storageKey: string, opts?: { preferFlash?: boolean }) {
  const { models, currentModel } = useApp()
  const textModels = models.filter(isTextModel)
  const [saved, setSaved] = useState(() => {
    try { return localStorage.getItem(storageKey) || '' } catch { return '' }
  })
  const keys = textModels.map(m => `${m.provider}/${m.id}`)
  const flash = textModels.find(m => /flash/i.test(m.id) && !/image|video/i.test(m.id))
  const flashKey = flash ? `${flash.provider}/${flash.id}` : ''
  const fallback = opts?.preferFlash && flashKey
    ? flashKey
    : (keys.includes(currentModel) ? currentModel : (keys[0] || ''))
  const value = saved || fallback
  const set = (next: string) => {
    setSaved(next)
    try { localStorage.setItem(storageKey, next) } catch {}
  }
  return { value, set, textModels }
}

export default function WorkshopModelPicker({ value, onChange, textModels, label = '模型' }: {
  value: string
  onChange: (v: string) => void
  textModels: Model[]
  label?: string
}) {
  if (!textModels.length) {
    return <span className="text-[11px] text-pi-dim2">没有可用文本模型——先到模型管理添加</span>
  }
  return (
    <label className="text-xs text-pi-dim flex flex-col sm:flex-row sm:items-center gap-1.5 w-full sm:w-auto">
      {label}
      <select className="input-pi min-h-11 !py-2 text-xs w-full sm:max-w-[260px]" value={value} onChange={e => onChange(e.target.value)}>
        {value && !textModels.some(m => `${m.provider}/${m.id}` === value) && <option value={value} disabled>已选模型不可用，请重新选择</option>}
        {textModels.map(m => (
          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
            {m.name}（{m.provider}）{m.free ? ' · 免费' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
