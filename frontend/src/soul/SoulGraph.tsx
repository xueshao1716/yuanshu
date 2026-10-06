import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { api } from '../api'
import { LoadState } from './shared'

// 灵魂图谱：小语在中间，性格/情绪/记忆/技能/学习五个枢纽围着她。
// 点枢纽 → 它退到左边，叶子扇形展开；点叶子 → 右侧看详情；Esc 或面包屑逐层返回。
// 画布只画连线、辉光和沿线的脉冲；节点是真按钮，可以 Tab 和读屏。

type Detail = { title: string; lead?: string; facts: [string, string][]; items: string[]; itemsTitle?: string; href?: string }
type GNode = { id: string; kind: 'core' | 'hub' | 'leaf'; hub?: string; label: string; en: string; metric?: string; value?: number; detail: Detail }
type GLink = { a: string; b: string; kind: 'tree' | 'cross' }
type Graph = { nodes: GNode[]; links: GLink[]; at: string }
type Pose = { x: number; y: number; o: number; s: number }

const TAU = Math.PI * 2
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function targets(g: Graph, W: number, H: number, focus: string | null): Record<string, Pose> {
  const out: Record<string, Pose> = {}
  const hubs = g.nodes.filter(n => n.kind === 'hub')
  const cx = W / 2, cy = H / 2
  const narrow = W < 520
  if (!focus) {
    out.core = { x: cx, y: cy, o: 1, s: 1 }
    const rx = Math.min(W * (narrow ? 0.34 : 0.33), H * 0.62), ry = H * 0.36
    hubs.forEach((h, i) => {
      const a = -Math.PI / 2 + (i / hubs.length) * TAU
      const hx = cx + Math.cos(a) * rx, hy = cy + Math.sin(a) * ry
      out[h.id] = { x: hx, y: hy, o: 1, s: 1 }
      const leaves = g.nodes.filter(n => n.hub === h.id)
      const r = (narrow ? 30 : 40) + Math.sqrt(leaves.length) * 4
      leaves.forEach((l, j) => {
        const b = a + ((j + 0.5) / Math.max(1, leaves.length) - 0.5) * Math.PI * 1.25
        out[l.id] = { x: hx + Math.cos(b) * r, y: hy + Math.sin(b) * r, o: 0, s: 0.6 }
      })
    })
    return out
  }
  const hx = W * (narrow ? 0.16 : 0.24)
  out.core = { x: W * 0.08, y: cy, o: narrow ? 0 : 0.55, s: 0.62 }
  for (const h of hubs) out[h.id] = h.id === focus ? { x: hx, y: cy, o: 1, s: 1.08 } : { x: out.core.x, y: cy, o: 0, s: 0.5 }
  const leaves = g.nodes.filter(n => n.hub === focus)
  // 叶子按高度均分（标签是横排的，按角度均分顶部会挤），横向沿椭圆收回来
  const R = Math.min(W * (narrow ? 0.36 : 0.4), 360)
  const span = Math.min(1, 0.13 * (leaves.length - 1)) * H * 0.42
  leaves.forEach((l, j) => {
    const t = leaves.length === 1 ? 0 : -1 + (2 * j) / (leaves.length - 1)
    out[l.id] = { x: hx + R * Math.sqrt(1 - 0.7 * t * t), y: cy + t * span, o: 1, s: 1 }
  })
  for (const n of g.nodes) if (!out[n.id]) out[n.id] = { x: out.core.x, y: cy, o: 0, s: 0.5 }
  return out
}

function readColors(el: HTMLElement) {
  const cs = getComputedStyle(el)
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d
  return { accent: v('--pi-accent', '#5468ff'), text: v('--pi-text', '#e8eef8'), dim: v('--pi-dim2', '#929cab') }
}
// '#rrggbb' / 'rgb(...)' → 'rgba(r,g,b,a)'
function alpha(color: string, a: number) {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    let h = hex[1]; if (h.length === 3) h = h.split('').map(c => c + c).join('')
    const n = parseInt(h, 16)
    return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/)
  if (rgb) { const [r, g, b] = rgb[1].split(/[ ,/]+/); return `rgba(${r},${g},${b},${a})` }
  return color
}
// 连线带一点弧度，像触须而不是直线
function curve(ax: number, ay: number, bx: number, by: number, seed: number) {
  const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = bx - ax, dy = by - ay
  const bend = (seed - 0.5) * 0.36
  return { cx: mx - dy * bend, cy: my + dx * bend }
}
const at = (a: number, c: number, b: number, t: number) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b

export default function SoulGraph() {
  const { data, error, isLoading, mutate } = useSWR<Graph>('soul-graph', () => api('/api/soul/graph'), { refreshInterval: 60000 })
  const [focus, setFocus] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [size, setSize] = useState({ W: 0, H: 0 })
  const stage = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const btns = useRef<Record<string, HTMLButtonElement | null>>({})
  const poses = useRef<Record<string, Pose>>({})
  const goal = useRef<Record<string, Pose>>({})

  const byId = useMemo(() => Object.fromEntries((data?.nodes || []).map(n => [n.id, n])), [data])
  const seeds = useMemo(() => (data?.links || []).map((_, i) => ((i * 7919) % 997) / 997), [data])

  useEffect(() => {
    const el = stage.current; if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ W: e.contentRect.width, H: e.contentRect.height }))
    ro.observe(el); return () => ro.disconnect()
  }, [data])

  useEffect(() => {
    if (!data || !size.W) return
    goal.current = targets(data, size.W, size.H, focus)
    for (const [id, p] of Object.entries(goal.current)) if (!poses.current[id] || reducedMotion()) poses.current[id] = { ...p }
  }, [data, size, focus])

  // 主循环：节点位置向目标缓动，画布跟着画；页面不可见或减少动态时停。
  useEffect(() => {
    if (!data || !size.W) return
    const cv = canvas.current!, ctx = cv.getContext('2d')!, el = stage.current!
    let colors = readColors(el)
    const mo = new MutationObserver(() => { colors = readColors(el) })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    cv.width = size.W * dpr; cv.height = size.H * dpr
    const still = reducedMotion()
    let raf = 0, last = performance.now(), visible = true
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame) })
    io.observe(el)

    function frame(now: number) {
      raf = 0
      const dt = Math.min(64, now - last); last = now
      const k = still ? 1 : 1 - Math.exp(-dt / 120)
      let moving = false
      for (const [id, g] of Object.entries(goal.current)) {
        const p = poses.current[id] || (poses.current[id] = { ...g })
        for (const key of ['x', 'y', 'o', 's'] as const) {
          const d = g[key] - p[key]
          if (Math.abs(d) > 0.001) { p[key] += d * k; moving = true } else p[key] = g[key]
        }
        const b = btns.current[id]
        if (b) {
          b.style.transform = `translate(${p.x}px, ${p.y}px) translate(${b.dataset.kind === 'leaf' ? '-11.5px' : '-50%'}, -50%) scale(${p.s})`
          b.style.opacity = String(p.o)
        }
      }
      draw(now)
      if (visible && !document.hidden && (!still || moving)) raf = requestAnimationFrame(frame)
    }
    function draw(now: number) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.W, size.H)
      const P = poses.current, core = P.core
      // 核心呼吸辉光
      if (core) {
        const breathe = still ? 1 : 1 + Math.sin(now / 1400) * 0.07
        const r = Math.min(size.W, size.H) * 0.3 * core.s * breathe
        const g = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, r)
        g.addColorStop(0, alpha(colors.accent, 0.22 * core.o)); g.addColorStop(1, alpha(colors.accent, 0))
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(core.x, core.y, r, 0, TAU); ctx.fill()
      }
      data!.links.forEach((l, i) => {
        const A = P[l.a], B = P[l.b]; if (!A || !B) return
        const leafA = byId[l.a]?.kind === 'leaf', leafB = byId[l.b]?.kind === 'leaf'
        // 总览里叶子按钮是隐藏的，但叶子要作为小点露出来
        const oa = leafA && !focus ? 0.5 : A.o, ob = leafB && !focus ? 0.5 : B.o
        const vis = Math.min(oa, ob); if (vis < 0.04) return
        const lit = !!focus && (l.a === focus || l.b === focus || l.a === picked || l.b === picked)
        const { cx, cy } = curve(A.x, A.y, B.x, B.y, seeds[i])
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.quadraticCurveTo(cx, cy, B.x, B.y)
        ctx.setLineDash(l.kind === 'cross' ? [3, 5] : [])
        ctx.strokeStyle = alpha(l.kind === 'cross' ? colors.dim : colors.accent, (l.kind === 'cross' ? 0.22 : lit ? 0.5 : 0.24) * vis)
        ctx.lineWidth = lit ? 1.4 : 1; ctx.stroke()
        if (!still && l.kind === 'tree') {
          const t = ((now / (2600 + seeds[i] * 1800)) + seeds[i]) % 1
          ctx.beginPath(); ctx.arc(at(A.x, cx, B.x, t), at(A.y, cy, B.y, t), lit ? 2 : 1.5, 0, TAU)
          ctx.fillStyle = alpha(colors.accent, 0.85 * vis); ctx.fill()
        }
      })
      ctx.setLineDash([])
      if (!focus) for (const n of data!.nodes) {
        if (n.kind !== 'leaf') continue
        const p = P[n.id]; if (!p) continue
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.6 + (n.value ?? 0.5) * 2.2, 0, TAU)
        ctx.fillStyle = alpha(colors.accent, 0.35 + (n.value ?? 0.5) * 0.45); ctx.fill()
      }
    }
    raf = requestAnimationFrame(frame)
    const onVis = () => { if (!document.hidden && !raf) { last = performance.now(); raf = requestAnimationFrame(frame) } }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelAnimationFrame(raf); mo.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis) }
  }, [data, size, focus, picked, byId, seeds])

  const back = useCallback(() => { if (picked) setPicked(null); else if (focus) setFocus(null) }, [picked, focus])
  const openHub = (id: string) => { setFocus(id); setPicked(null) }
  const onNode = (n: GNode) => n.kind === 'core' ? (setFocus(null), setPicked(null)) : n.kind === 'hub' ? openHub(n.id) : setPicked(n.id)

  if (error || isLoading || !data) return <LoadState error={error} loading={isLoading || !data} retry={mutate} />
  const shown = byId[picked || focus || 'core']
  const hubs = data.nodes.filter(n => n.kind === 'hub')

  return (
    <div className="sg" onKeyDown={e => { if (e.key === 'Escape' && (focus || picked)) { e.preventDefault(); back() } }}>
      <nav className="sg-crumbs" aria-label="图谱层级">
        <button type="button" onClick={() => { setFocus(null); setPicked(null) }} aria-current={!focus ? 'true' : undefined}>{byId.core?.label}</button>
        {focus && <><span aria-hidden="true">/</span><button type="button" onClick={() => setPicked(null)} aria-current={!picked ? 'true' : undefined}>{byId[focus]?.label}</button></>}
        {picked && <><span aria-hidden="true">/</span><span aria-current="true">{byId[picked]?.label}</span></>}
        <span className="sg-crumb-hint">{focus ? 'Esc 返回' : '点枢纽展开'}</span>
      </nav>
      <div className="sg-body">
        <div className="sg-stage" ref={stage} data-focus={focus ? 'hub' : 'overview'}>
          <canvas ref={canvas} className="sg-canvas" aria-hidden="true" />
          {data.nodes.map(n => {
            const hidden = n.kind === 'leaf' ? n.hub !== focus : n.kind === 'hub' ? !!focus && focus !== n.id : false
            return (
              <button key={n.id} type="button" ref={el => { btns.current[n.id] = el }}
                className={`sg-node sg-${n.kind}`} data-kind={n.kind} data-picked={picked === n.id || (n.kind === 'hub' && focus === n.id) ? 'true' : undefined}
                tabIndex={hidden ? -1 : 0} aria-hidden={hidden || undefined} style={{ pointerEvents: hidden ? 'none' : undefined, opacity: 0 }}
                aria-label={`${n.label}${n.metric ? `，${n.metric}` : ''}`} onClick={() => onNode(n)}>
                {n.kind === 'leaf'
                  ? <><i className="sg-dot" style={{ opacity: 0.45 + (n.value ?? 0.5) * 0.55 }} aria-hidden="true" /><span className="sg-label">{n.label}</span>{n.metric && <span className="sg-metric">{n.metric}</span>}</>
                  : <><span className="sg-label">{n.label}</span><span className="sg-en">{n.kind === 'core' ? n.metric || n.en : n.metric}</span></>}
              </button>
            )
          })}
        </div>
        <aside className="sg-panel" aria-live="polite">
          <p className="sg-kicker">{shown.kind === 'core' ? 'SOUL' : shown.en}<span>{shown.kind === 'core' ? '核心' : shown.kind === 'hub' ? '枢纽' : byId[shown.hub || '']?.label}</span></p>
          <h4>{shown.detail.title}</h4>
          {shown.detail.lead && <p className="sg-lead">{shown.detail.lead}</p>}
          {shown.kind === 'leaf' && typeof shown.value === 'number' && <div className="sg-meter" aria-hidden="true"><i style={{ width: `${Math.round(shown.value * 100)}%` }} /></div>}
          {!!shown.detail.facts.length && <dl className="sg-facts">{shown.detail.facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
          {!!shown.detail.items.length && <><p className="sg-items-title">{shown.detail.itemsTitle || '条目'}</p><ul className="sg-items">{shown.detail.items.map((t, i) => <li key={i}>{t}</li>)}</ul></>}
          {shown.kind === 'core' && <div className="sg-hub-list">{hubs.map(h => <button type="button" key={h.id} onClick={() => openHub(h.id)}><span>{h.label}</span><small>{h.metric}</small></button>)}</div>}
          {shown.detail.href && shown.kind !== 'core' && <a href={shown.detail.href}>去对应页面</a>}
        </aside>
      </div>
    </div>
  )
}
