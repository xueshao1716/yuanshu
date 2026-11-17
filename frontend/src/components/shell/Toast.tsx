import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, Info, Loader2 } from 'lucide-react'
import { EMPTY, pushToast, expireToast, dismissToast, nextDelay } from '../../lib/toast-queue.mjs'
import { useLiquidGlass } from './LiquidGlass'

// 全局通知（2026-08-25 起：消灭静默 catch{}——操作失败必须让用户看见）。
// 2026-11-17 改「灵动胶囊」：全屏只有一个胶囊，新消息原地变形；同一句话合并成 ×N；
// 带 key 的任务在同一个胶囊里推进进度（sticky 常驻，完成时同 key 再发一次 ok/error 收尾）。
// 用法：toast('模型切换失败', 'error')；toast('生成中 2/5', 'info', { key: 'gen', progress: 0.4, sticky: true })
type Tone = 'info' | 'error' | 'ok'
interface Opts { key?: string; progress?: number | null; sticky?: boolean }
interface Input extends Opts { id: number; msg: string; tone: Tone }
type Event = { type: 'push'; input: Input } | { type: 'dismiss'; key: string }

const listeners = new Set<(e: Event) => void>()
let seq = 0

function emit(e: Event) { listeners.forEach(l => l(e)) }

export const toast = Object.assign(
  (msg: string, tone: Tone = 'info', opts: Opts = {}) => {
    emit({ type: 'push', input: { id: ++seq, msg, tone, ...opts } })
    return opts.key
  },
  { dismiss: (key: string) => emit({ type: 'dismiss', key }) },
)

type State = typeof EMPTY & { cur: any }
function reducer(s: State, a: Event | { type: 'expire' }): State {
  const now = Date.now()
  if (a.type === 'push') return pushToast(s, a.input, now)
  if (a.type === 'dismiss') return dismissToast(s, a.key, now)
  return expireToast(s, now)
}

const TONE = {
  error: { tint: 'var(--pi-danger)', Icon: AlertCircle },
  ok: { tint: 'var(--pi-success)', Icon: CheckCircle2 },
  info: { tint: 'var(--pi-accent)', Icon: Info },
} as const

export function Toaster() {
  const [state, dispatch] = useReducer(reducer, EMPTY as State)
  const [hover, setHover] = useState(false)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const shell = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const last = useRef<any>(null)
  if (state.cur) last.current = state.cur
  const it = state.cur || last.current
  const open = !!state.cur

  useEffect(() => {
    const l = (e: Event) => dispatch(e)
    listeners.add(l)
    // 非 React 代码（旧页面、调试脚本）也能弹：window.dispatchEvent(new CustomEvent('pi:toast', { detail: { msg, tone } }))
    const fromWindow = (e: any) => { const d = e?.detail || {}; if (d.msg) toast(String(d.msg), d.tone, d) }
    window.addEventListener('pi:toast', fromWindow)
    return () => { listeners.delete(l); window.removeEventListener('pi:toast', fromWindow) }
  }, [])

  // 计时：悬停时不收；有排队时报错停满保底就让位
  useEffect(() => {
    if (!state.cur || hover) return
    const ms = nextDelay(state, Date.now())
    if (ms === Infinity) return
    const t = setTimeout(() => dispatch({ type: 'expire' }), ms)
    return () => clearTimeout(t)
  }, [state, hover])

  // 量内容的自然尺寸，外壳用宽高过渡做「原地变形」（auto 宽度没法直接过渡）
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [it?.id])

  useLiquidGlass(shell, { radius: size.h > 52 ? 20 : size.h / 2, strength: 0.8, active: open })

  if (!it) return null
  const tone = TONE[it.tone as Tone] || TONE.info
  const busy = it.progress != null && it.progress < 1
  const Icon = busy ? Loader2 : tone.Icon
  return (
    <div aria-live="polite" className="toast-stack fixed left-1/2 -translate-x-1/2 z-[var(--pi-z-toast)] flex justify-center pointer-events-none">
      <div ref={shell} role="status" data-open={open} data-tone={it.tone}
        className="pi-island liquid-glass pointer-events-auto cursor-default"
        style={{ width: size.w || undefined, height: size.h || undefined, borderRadius: size.h > 52 ? 20 : 999, ['--lg-tint' as any]: tone.tint }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        onClick={() => dispatch({ type: 'expire' })} title="点一下收起">
        <div ref={inner} key={it.id} className="pi-island__body">
          <Icon className={`pi-island__icon ${busy ? 'animate-spin' : ''}`} strokeWidth={2} />
          <span className="pi-island__msg">{it.msg}</span>
          {it.count > 1 && <span key={it.count} className="pi-island__count">×{it.count}</span>}
          {state.queue.length > 0 && <span className="pi-island__more" title="后面还有">+{state.queue.length}</span>}
        </div>
        {it.progress != null && (
          <div className="pi-island__bar" style={{ transform: `scaleX(${Math.max(0, Math.min(1, it.progress))})` }} />
        )}
      </div>
    </div>
  )
}
