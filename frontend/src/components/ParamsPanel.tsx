import { useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'

// 模型参数面板（2026-08-26，对标 vanilla dd-params / Open WebUI）
// 本机后续消息共用；localStorage 'pi_params' 持久化，发送时随请求交给服务端适配。

export function readParams(): { temperature?: number; top_p?: number } | undefined {
  try {
    const v = JSON.parse(localStorage.getItem('pi_params') || 'null')
    if (v && (Number.isFinite(v.temperature) || Number.isFinite(v.top_p))) return {
      ...(Number.isFinite(v.temperature) && v.temperature >= 0 && v.temperature <= 2 ? { temperature: v.temperature } : {}),
      ...(Number.isFinite(v.top_p) && v.top_p > 0 && v.top_p <= 1 ? { top_p: v.top_p } : {}),
    }
  } catch {}
  return undefined
}

const DEFAULTS = { temperature: 0.7, top_p: 0.95 }

export default function ParamsPanel() {
  const [open, setOpen] = useState(false)
  const [temp, setTemp] = useState(DEFAULTS.temperature)
  const [topP, setTopP] = useState(DEFAULTS.top_p)
  const [custom, setCustom] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  // 初始化：读已保存值
  useEffect(() => {
    try {
      const v = readParams()
      if (v) { setTemp(v.temperature ?? DEFAULTS.temperature); setTopP(v.top_p ?? DEFAULTS.top_p); setCustom(true) }
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
    setCustom(true)
    try { localStorage.setItem('pi_params', JSON.stringify({ temperature: t, top_p: p })) } catch {}
  }

  return (
    // 注意：这里**不能**加 relative（2026-09-18）。加了之后弹窗的 right-0 是以"这个按钮"为基准，
    // 而按钮右边还有麦克风/附件/发送，窄屏（320）时弹窗往左长就贴到屏幕边（实测 left=3px）。
    // 去掉 relative → 弹窗按 SendBox 根节点（整条输入框）定位，右边缘对齐输入框右侧，自然不贴边。
    <div ref={boxRef}>
      <button onClick={() => setOpen(o => !o)}
        className={`btn-tool-sm touch-hit ${open ? 'text-pi-accent' : ''}`}
        title="模型参数（temperature / top_p）" aria-label="模型参数" aria-expanded={open}>
        <SlidersHorizontal className="w-4 h-4" strokeWidth={1.8} />
      </button>
      {open && (
        <div
          className="absolute bottom-full right-0 mb-2 w-48 max-w-[calc(100vw-24px)] max-h-[70vh] overflow-y-auto panel !p-2 z-[var(--pi-z-dialog)]"
          role="dialog" aria-label="模型参数">
          <div className="text-[11px] font-medium text-pi-text mb-1.5">模型参数</div>
          <p className="text-[10px] text-pi-dim mb-1.5">{custom ? '自定义 · 下次发送生效' : '模型默认 · 调节后启用自定义'}</p>

          <label className="block mb-1.5">
            <div className="flex justify-between text-[10px] text-pi-dim mb-0.5">
              <span>temperature（发散度）</span><span className="font-mono text-pi-accent">{custom ? temp.toFixed(1) : '默认'}</span>
            </div>
            <input aria-label="temperature（发散度）" type="range" min={0} max={2} step={0.1} value={temp}
              onChange={e => { const v = Number(e.target.value); setTemp(v); persist(v, topP) }}
              className="w-full h-3.5 accent-[var(--pi-accent)]" />
          </label>

          <label className="block mb-1.5">
            <div className="flex justify-between text-[10px] text-pi-dim mb-0.5">
              <span>top_p（核采样）</span><span className="font-mono text-pi-accent">{custom ? topP.toFixed(2) : '默认'}</span>
            </div>
            <input aria-label="top_p（核采样）" type="range" min={0.05} max={1} step={0.05} value={topP}
              onChange={e => { const v = Number(e.target.value); setTopP(v); persist(temp, v) }}
              className="w-full h-3.5 accent-[var(--pi-accent)]" />
          </label>

          <div className="flex items-center justify-between pt-0.5">
            <span className="text-[9.5px] text-pi-dim2">本机后续消息使用</span>
            <button onClick={() => {
              try { localStorage.removeItem('pi_params') } catch {}
              setCustom(false)
              setTemp(DEFAULTS.temperature); setTopP(DEFAULTS.top_p)
            }} className="text-[10px] text-pi-dim hover:text-pi-accent transition-colors">恢复默认</button>
          </div>
          <p className="text-[10px] text-pi-dim mt-1.5">以模型支持为准；部分推理模型不接受采样设置。Claude 优先发散度，上限 1。</p>
        </div>
      )}
    </div>
  )
}
