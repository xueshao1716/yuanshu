import { useEffect, useState } from 'react'

// 极简全局 toast（2026-08-25）：消灭静默 catch{}——操作失败必须让用户看见。
// 用法：toast('模型切换失败', 'error')；App 挂一次 <Toaster />。
type Tone = 'info' | 'error' | 'ok'
interface Item { id: number; msg: string; tone: Tone }

type Listener = (item: Item) => void
const listeners = new Set<Listener>()
let seq = 0

export function toast(msg: string, tone: Tone = 'info') {
  const item: Item = { id: ++seq, msg, tone }
  listeners.forEach(l => l(item))
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([])
  useEffect(() => {
    const l: Listener = (item) => {
      setItems(prev => [...prev.slice(-2), item]) // 最多同屏 3 条
      setTimeout(() => setItems(prev => prev.filter(x => x.id !== item.id)), item.tone === 'error' ? 5000 : 3000)
    }
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  if (!items.length) return null
  return (
    <div aria-live="polite" className="toast-stack fixed left-1/2 -translate-x-1/2 z-[var(--pi-z-toast)] flex flex-col gap-2 items-center pointer-events-none">
      {items.map(it => {
        // 用主题语义 token（inline style 直用 var，绕开 UnoCSS 对 var() /opacity 失效）：
        // 深浅主题自适应——亮色主题=亮纸底+深语义字；深色主题=深底+亮语义字，绝无黑块
        const tone = it.tone === 'error'
          ? { bg: 'color-mix(in oklab, var(--pi-danger) 14%, transparent)', fg: 'var(--pi-danger)', border: 'color-mix(in oklab, var(--pi-danger) 45%, transparent)' }
          : it.tone === 'ok'
            ? { bg: 'color-mix(in oklab, var(--pi-success) 14%, transparent)', fg: 'var(--pi-success)', border: 'color-mix(in oklab, var(--pi-success) 45%, transparent)' }
            : { bg: 'color-mix(in oklab, var(--pi-bg1) 92%, transparent)', fg: 'var(--pi-text)', border: 'var(--pi-border-soft)' }
        return (
          <div key={it.id} role="status"
            className="anim-fade px-4 py-2 rounded-pi-lg border text-[13px] shadow-xl max-w-[80vw]"
            style={{ background: tone.bg, color: tone.fg, borderColor: tone.border }}>
            {it.msg}
          </div>
        )
      })}
    </div>
  )
}
