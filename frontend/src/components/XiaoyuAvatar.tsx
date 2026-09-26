// XiaoyuAvatar 小语全景形象（2026-09-26，v0.3-panel）
// 从 工程/xiaoyu-avatar v0.2 原型移植到 React：视觉语言整套保留
// （220 斐波那契粒子球 / 72 段刻度环 / 星尘视差 / 三层 guide / 旋转六边形 /
//   下行扫描线 / HUD 真实读数 / 切态 glitch / 四角括弧），但驱动模型换成
//   本仓的连续 VAD 参数（lib/emotion.ts vadVisual 七参数），不是三态离散——
//   MoodOrb（30px 角标）与它是同一灵魂的两个尺度，数据流同源。
// 工程护栏同 MoodOrb：DPR 钳 2 / dt 钳 100ms / 页签隐藏停 rAF / reduced-motion 静态一帧。
// effect 依赖刻意不含 state/label：SWR 每 20s 轮询会给新对象引用，
// 进来会重建画布（重置缓动→情绪跳变），目标参数走 ref（同 MoodOrb 模式）。

import { useEffect, useRef } from 'react'
import { vadVisual, type MoodVisual } from '../lib/emotion'
import { hsla, tickRingAlpha, readoutLines, particleSphere, dustField } from '../lib/avatar-lang'

const EASE_K = 3.2 // 目标参数追赶：时间常数约 0.31s
const DT_MAX = 0.1
const N = 220 // 粒子球粒子数（原型定值）
const DUST = 90 // 星尘数
const TICKS = 72 // 刻度环段数（面板尺度塞得下完整 72 段）
const SCAN_PERIOD = 6.0 // 扫描线一轮秒数
const JUMP_HUE = 24 // 情绪急动判定（同 MoodOrb）
const JUMP_LIGHT = 10

export function XiaoyuAvatar({ state, label = '小语', className }: { state?: any; label?: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const targetRef = useRef<MoodVisual>(vadVisual(state))
  const rawRef = useRef<any>(state)
  const labelRef = useRef<string>(label)
  useEffect(() => { targetRef.current = vadVisual(state); rawRef.current = state; labelRef.current = label })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const particles = particleSphere(N)
    const dust = dustField(DUST)

    const resize = () => {
      const cw = canvas.clientWidth || 360
      canvas.width = Math.max(1, Math.round(cw * dpr))
      canvas.height = Math.max(1, Math.round(cw * dpr))
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(canvas)
    window.addEventListener('resize', resize)

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let cur: MoodVisual = { ...targetRef.current }
    let spin = 0
    let scan = Math.random() * SCAN_PERIOD
    let jump = 0
    let frameMs = 16.7
    let raf = 0
    let last = performance.now()
    let alive = true
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 }
    const onMove = (e: MouseEvent) => {
      mouse.tx = e.clientX / window.innerWidth - 0.5
      mouse.ty = e.clientY / window.innerHeight - 0.5
    }
    if (!reduced) window.addEventListener('mousemove', onMove, { passive: true })

    const draw = (now: number, dt: number) => {
      frameMs = frameMs * 0.9 + dt * 1000 * 0.1
      const k = 1 - Math.exp(-EASE_K * dt)
      const tgt = targetRef.current
      if (jump === 0 && (Math.abs(tgt.hue - cur.hue) > JUMP_HUE || Math.abs(tgt.light - cur.light) > JUMP_LIGHT)) jump = 1
      cur = {
        hue: cur.hue + (tgt.hue - cur.hue) * k,
        sat: cur.sat + (tgt.sat - cur.sat) * k,
        light: cur.light + (tgt.light - cur.light) * k,
        tempo: cur.tempo + (tgt.tempo - cur.tempo) * k,
        glow: cur.glow + (tgt.glow - cur.glow) * k,
        depth: cur.depth + (tgt.depth - cur.depth) * k,
        drift: cur.drift + (tgt.drift - cur.drift) * k,
      }
      mouse.x += (mouse.tx - mouse.x) * Math.min(1, 6 * dt)
      mouse.y += (mouse.ty - mouse.y) * Math.min(1, 6 * dt)
      spin += dt * (0.25 + (0.25 + 0.7 * cur.glow) * 0.5)
      jump *= Math.exp(-7 * dt)
      scan = (scan + dt / SCAN_PERIOD) % 1

      // VAD 连续参数 → 原型的三参数（同一灵魂的连续化：无跳变、可反向）
      const energy = 0.25 + 0.7 * cur.glow
      const turbulence = Math.max(0.05, Math.min(0.95, cur.tempo / 1.3))
      const openness = 0.55 + 0.45 * cur.glow

      const w = canvas.width, h = canvas.height
      const cx = w / 2 + mouse.x * 26 * dpr, cy = h / 2 + mouse.y * 18 * dpr
      const S = Math.min(w, h)
      const R = S * (0.16 + (openness - 0.55) * 0.05)
      const A = (a: number) => hsla(cur.hue, cur.sat, cur.light, a)
      const jit = jump * 7 * dpr

      ctx.clearRect(0, 0, w, h)
      ctx.font = Math.round(10 * dpr) + 'px ui-monospace,SFMono-Regular,Menlo,monospace'

      // 星尘层（远近两档，鼠标视差）
      for (let i = 0; i < dust.length; i++) {
        const d = dust[i]
        d.a += d.v * 0.00002 * dt * 60
        const dx = cx + Math.cos(d.a) * d.r * S * 0.46 + mouse.x * 30 * dpr * d.r
        const dy = cy + Math.sin(d.a) * d.r * S * 0.46 + mouse.y * 20 * dpr * d.r
        if (d.r < 0.7) {
          ctx.fillStyle = A(d.o * 0.6)
          ctx.beginPath(); ctx.arc(dx, dy, 0.7 * dpr, 0, Math.PI * 2); ctx.fill()
        } else {
          ctx.strokeStyle = A(d.o * 0.5)
          ctx.lineWidth = 0.8 * dpr
          ctx.beginPath()
          ctx.moveTo(dx, dy)
          ctx.lineTo(dx + Math.cos(d.a + 1.57) * 4 * dpr, dy + Math.sin(d.a + 1.57) * 4 * dpr)
          ctx.stroke()
        }
      }

      // 三层同心虚线 guide
      const guides = [0.63, 0.72, 0.82]
      for (let i = 0; i < guides.length; i++) {
        ctx.setLineDash([2 * dpr, 6 * dpr])
        ctx.strokeStyle = A(0.05 + energy * 0.04)
        ctx.lineWidth = 1 * dpr
        ctx.beginPath(); ctx.arc(cx, cy, S * guides[i] / 2, 0, Math.PI * 2); ctx.stroke()
      }
      ctx.setLineDash([])

      // 刻度环 72 段：连续模式（亮弧巡游 + 脉动），不随情绪硬切模式
      const rt = S * 0.225 * (0.8 + openness * 0.24)
      const head = (spin * 1.4) % (Math.PI * 2)
      ctx.lineWidth = 1 * dpr
      for (let i = 0; i < TICKS; i++) {
        const ang = (i / TICKS) * Math.PI * 2 + spin * 0.18
        const long = i % 6 === 0
        const len = (long ? 13 : 6) * dpr * (0.7 + energy * 0.5)
        ctx.strokeStyle = A(tickRingAlpha(i, TICKS, head, energy, now))
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(ang) * rt, cy + Math.sin(ang) * rt)
        ctx.lineTo(cx + Math.cos(ang) * (rt + len), cy + Math.sin(ang) * (rt + len))
        ctx.stroke()
      }

      // 粒子球：湍流呼吸 + 自转 + 深度投影 + 扫描线提亮 + glitch 抖动
      const cs = Math.cos(spin), sn = Math.sin(spin)
      for (let i = 0; i < N; i++) {
        const p = particles[i]
        const wob = 1 + Math.sin(now * 0.0016 + p.seed) * turbulence * 0.35
        const px = p.x * cs - p.z * sn, pz = p.x * sn + p.z * cs, py = p.y * wob
        const depth = (pz + 1) / 2
        const gx = jump > 0.01 ? (Math.random() - 0.5) * jit : 0
        const sx = cx + px * R + gx, sy = cy + py * R
        const lifted = Math.max(0, 1 - Math.abs(sy - scan * h) / (26 * dpr))
        const size = (0.6 + depth * 1.7) * dpr * (0.5 + energy * 0.7)
        const alpha = (0.12 + depth * 0.55) * (0.45 + energy * 0.75) + lifted * 0.35
        ctx.fillStyle = A(Math.min(1, alpha))
        ctx.beginPath(); ctx.arc(sx, sy, size, 0, Math.PI * 2); ctx.fill()
      }

      // 内核 + 旋转六边形符号
      const core = S * 0.14 * (0.75 + energy * 0.5)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, core)
      g.addColorStop(0, A(0.9 * energy + 0.1))
      g.addColorStop(0.35, A(0.28 * energy))
      g.addColorStop(1, A(0))
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(cx, cy, core, 0, Math.PI * 2); ctx.fill()

      const hr = R * 0.52 * (0.8 + openness * 0.3)
      ctx.strokeStyle = A(0.34 + energy * 0.4)
      ctx.lineWidth = 1.2 * dpr
      ctx.beginPath()
      for (let i = 0; i <= 6; i++) {
        const ha = spin * 0.6 + i * Math.PI / 3
        const hx = cx + Math.cos(ha) * hr, hy = cy + Math.sin(ha) * hr
        if (i === 0) ctx.moveTo(hx, hy); else ctx.lineTo(hx, hy)
      }
      ctx.stroke()
      ctx.fillStyle = A(0.5 + energy * 0.5)
      ctx.beginPath(); ctx.arc(cx, cy, 2.2 * dpr, 0, Math.PI * 2); ctx.fill()

      // 扫描线：下行掠过，线性渐变一带
      const ly = scan * h
      const lg = ctx.createLinearGradient(0, ly - 26 * dpr, 0, ly + 26 * dpr)
      lg.addColorStop(0, A(0)); lg.addColorStop(0.5, A(0.12)); lg.addColorStop(1, A(0))
      ctx.strokeStyle = lg
      ctx.lineWidth = 1 * dpr
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke()

      // HUD 四角读数：全部真实运行值（诚实外化，非贴图）
      const pad = 16 * dpr
      const raw = rawRef.current || {}
      const vRaw = Number(raw.valence), aRaw = Number(raw.arousal), dRaw = Number(raw.dominance)
      const lines = readoutLines({
        frameMs, energy, turbulence, openness,
        v: Number.isFinite(vRaw) ? vRaw : 0,
        a: Number.isFinite(aRaw) ? aRaw : 0,
        d: Number.isFinite(dRaw) ? dRaw : 0,
        stateLabel: labelRef.current, mx: mouse.x, my: mouse.y,
      })
      for (const ln of lines) {
        if (ln.pos === 'tl') { ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = A(0.34); ctx.fillText(ln.text, pad, pad) }
        else if (ln.pos === 'tr') { ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = A(0.34); ctx.fillText(ln.text, w - pad, pad) }
        else if (ln.pos === 'tr2') { ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.fillStyle = A(0.4 + energy * 0.3); ctx.fillText(ln.text, w / 2 + 30 * dpr, pad) }
        else if (ln.pos === 'bl2') { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = A(0.34); ctx.fillText(ln.text, pad, h - pad - 12 * dpr) }
        else if (ln.pos === 'bl') { ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = A(0.4 + energy * 0.3); ctx.fillText(ln.text, pad, h - pad) }
        else { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = A(0.5); ctx.fillText(ln.text, w - pad, h - pad) }
      }

      // 四角括弧
      const bl = 20 * dpr, bo = 14 * dpr
      ctx.strokeStyle = A(0.5)
      ctx.lineWidth = 1.4 * dpr
      ctx.beginPath()
      ctx.moveTo(bo, bo + bl); ctx.lineTo(bo, bo); ctx.lineTo(bo + bl, bo)
      ctx.moveTo(w - bo, bo + bl); ctx.lineTo(w - bo, bo); ctx.lineTo(w - bo - bl, bo)
      ctx.moveTo(bo, h - bo - bl); ctx.lineTo(bo, h - bo); ctx.lineTo(bo + bl, h - bo)
      ctx.moveTo(w - bo, h - bo - bl); ctx.lineTo(w - bo, h - bo); ctx.lineTo(w - bo - bl, h - bo)
      ctx.stroke()
    }

    const frame = (now: number) => {
      if (!alive) return
      if (document.hidden) { raf = 0; return }
      const dt = Math.min(DT_MAX, Math.max(0, (now - last) / 1000))
      last = now
      draw(now, dt)
      raf = requestAnimationFrame(frame)
    }
    const onVis = () => {
      if (!alive || reduced) return
      if (!document.hidden && raf === 0) { last = performance.now(); raf = requestAnimationFrame(frame) }
    }
    document.addEventListener('visibilitychange', onVis)

    if (reduced) {
      draw(performance.now(), 0) // 静态一帧：参数仍忠实反映当下情绪
    } else {
      raf = requestAnimationFrame(frame)
    }
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      ro?.disconnect()
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={`小语完整形象：${label}`}
    />
  )
}
