import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'

// 模型参数面板（2026-08-26，对标 vanilla dd-params / Open WebUI）
// temperature / top_p 会话级可调；localStorage 'pi_params' 持久化，
// 发送时由 ChatArea 读取并随请求体带给 server（unified-chat 已支持）。

export function readParams(): { temperature?: number; top_p?: number } | undefined {
  try {
    const v = JSON.parse(localStorage.getItem('pi_params') || 'null')
    if (v && typeof v.temperature === 'number') return v
  } catch {}
  return undefined
}

const DEFAULTS = { temperature: 0.7, top_p: 0.95 }

export default function ParamsPanel() {
  const [open, setOpen] = useState(false)
  const [temp, setTemp] = useState(DEFAULTS.temperature)
  const [topP, setTopP] = useState(DEFAULTS.top_p)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // 初始化：读已保存值
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem('pi_params') || 'null')
      if (v) { setTemp(v.temperature ?? DEFAULTS.temperature); setTopP(v.top_p ?? DEFAULTS.top_p) }
    } catch {}
  }, [])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  const persist = (t: number, p: number) => {
    try { localStorage.setItem('pi_params', JSON.stringify({ temperature: t, top_p: p })) } catch {}
  }

  return (
    <div ref={boxRef} className="relative">
      <button onClick={() => setOpen(o => !o)}
        className={`btn-tool-sm touch-hit ${open ? 'text-pi-accent' : ''}`}
        title="模型参数（temperature / top_p）" aria-label="模型参数" aria-expanded={open}>
        <SlidersHorizontal className="w-4 h-4" strokeWidth={1.8} />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-56 max-w-[calc(100vw-20px)] panel !p-2.5 z-[var(--pi-z-dialog)]" role="dialog" aria-label="模型参数">
          <div className="text-[11.5px] font-medium text-pi-text mb-2">模型参数</div>

          <label className="block mb-2">
            <div className="flex justify-between text-[10.5px] text-pi-dim mb-0.5">
              <span>temperature（发散度）</span><span className="font-mono text-pi-accent">{temp.toFixed(1)}</span>
            </div>
            <input type="range" min={0} max={1} step={0.1} value={temp}
              onChange={e => { const v = Number(e.target.value); setTemp(v); persist(v, topP) }}
              className="w-full h-4 accent-[var(--pi-accent)]" />
          </label>

          <label className="block mb-2">
            <div className="flex justify-between text-[10.5px] text-pi-dim mb-0.5">
              <span>top_p（核采样）</span><span className="font-mono text-pi-accent">{topP.toFixed(2)}</span>
            </div>
            <input type="range" min={0.05} max={0.95} step={0.05} value={topP}
              onChange={e => { const v = Number(e.target.value); setTopP(v); persist(temp, v) }}
              className="w-full h-4 accent-[var(--pi-accent)]" />
          </label>

          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[10px] text-pi-dim2">会话级 · 存本地</span>
            <button onClick={() => {
              localStorage.removeItem('pi_params')
              setTemp(DEFAULTS.temperature); setTopP(DEFAULTS.top_p)
            }} className="text-[10.5px] text-pi-dim hover:text-pi-accent transition-colors">恢复默认</button>
          </div>
        </div>
      )}
    </div>
  )
}
