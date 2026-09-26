// MoodOrb 情绪灵珠（2026-09-03 创建 / 2026-09-26 HUD 化 v0.2）
// 一颗柔光玻璃球，内在随服务端 VAD 情绪连续变化，替代旧的 emoji 八桶。
// 设计语言借鉴 murmur-web（krispuckett/murmur-web）：
//   · 状态即运动——情绪不靠图标文字，靠节奏/色相/明度被读到；
//   · 一个身体，内在无限——永远是同一颗球，变的只是内在；
//   · 参数指数缓动追赶目标（≈0.6s 走完主要过渡），情绪变化读作「换了念头」而非「换了图标」；
//   · 积分相位驱动呼吸——tempo 变速时相位连续，材质不跳帧（murmur 的 clock 思想）。
// 30px 级小球用 2D canvas 足够，不引 WebGPU/WebGL，零运行时依赖。
//
// 2026-09-26 v0.2：嫁接 xiaoyu-avatar 原型的「仪器层」语言（工程/xiaoyu-avatar v0.2）——
// 右上角 30px 塞不进完整 HUD（72 段刻度+10px 读数全糊），所以按比例移植三件:
//   ① 24 段刻度弧 + 相位流动亮弧（tempo 越快流动越快，arousal 越高弧越亮）
//   ② 横扫扫描光带（5s 一轮，扫过时局部提亮=雷达回波感）
//   ③ 情绪急动 glitch：目标参数突变时一帧错位，「心里咯噔一下」
// 灵魂不动：7 连续参数、积分相位、指数缓动、数据流（vadVisual 输入输出）全部原样。

import { useEffect, useRef } from 'react'
import { vadVisual, type MoodVisual } from '../lib/emotion'

// 缓动速率（每秒）：时间常数约 0.31s，主要过渡 ≈0.6s 走完，同 murmur TRANSITION_DURATION 量级
const EASE_K = 3.2
const DT_MAX = 0.1 // 页签切回时的大 dt 必须截断，防止缓动瞬跳
const TICKS = 24 // 刻度弧段数（30px 球约每段 1.5px，读出「刻度」而不糊）
const SCAN_PERIOD = 5.0 // 扫描光带一轮秒数
const JUMP_HUE = 24 // 急动判定：色相目标跳变超过此值触发 glitch 帧
const JUMP_LIGHT = 10 // 急动判定：明度目标跳变

export function MoodOrb({ state, size = 20, label }: { state?: any; size?: number; label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // target 只在情绪快照变化时更新；渲染循环从 ref 读，避免每帧重建 effect
  const targetRef = useRef<MoodVisual>(vadVisual(state))
  useEffect(() => {
    targetRef.current = vadVisual(state)
  }, [state])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.max(1, Math.round(size * dpr))
    canvas.height = Math.max(1, Math.round(size * dpr))
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    let cur: MoodVisual = { ...targetRef.current }
    let phase = Math.random() * Math.PI * 2 // 起始相位随机，多颗球不同步
    let scanPhase = Math.random() * SCAN_PERIOD // 扫描光带相位同样积分驱动
    let jumpFrames = 0 // 急动 glitch 剩余帧数
    let raf = 0
    let last = performance.now()
    let alive = true

    const draw = (now: number) => {
      const dt = Math.min(DT_MAX, Math.max(0, (now - last) / 1000))
      last = now
      const k = 1 - Math.exp(-EASE_K * dt)
      const tgt = targetRef.current
      // 情绪急动：目标相对当前连续值跳变（引擎快照跳动，而非缓动中的逐步靠近）
      if (jumpFrames === 0 && (Math.abs(tgt.hue - cur.hue) > JUMP_HUE || Math.abs(tgt.light - cur.light) > JUMP_LIGHT)) {
        jumpFrames = 3
      }
      cur = {
        hue: cur.hue + (tgt.hue - cur.hue) * k,
        sat: cur.sat + (tgt.sat - cur.sat) * k,
        light: cur.light + (tgt.light - cur.light) * k,
        tempo: cur.tempo + (tgt.tempo - cur.tempo) * k,
        glow: cur.glow + (tgt.glow - cur.glow) * k,
        depth: cur.depth + (tgt.depth - cur.depth) * k,
        drift: cur.drift + (tgt.drift - cur.drift) * k,
      }
      // 积分相位：tempo 变速时 sin 输入连续，呼吸不跳帧
      phase += dt * Math.PI * 2 * cur.tempo
      scanPhase = (scanPhase + dt) % SCAN_PERIOD

      const c = Math.round(size * dpr) / 2
      const R = c - dpr * 1.5 // 留半圈给刻度弧
      const breathe = 1 + 0.05 * Math.sin(phase)
      const r = R * breathe
      const h = cur.hue, s = cur.sat, l = cur.light
      const jump = jumpFrames > 0 ? (jumpFrames % 2 === 0 ? 1 : -1) : 0 // 交错偏移=错位感
      if (jumpFrames > 0) jumpFrames -= 1
      const jx = jump * 0.8 * dpr // 30px 尺度只位移 <1px，是「咯噔」不是「撕裂」

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // 外辉光（glow 驱动的一圈柔光）
      if (cur.glow > 0.02) {
        const g = ctx.createRadialGradient(c, c, r * 0.6, c, c, r * 1.5)
        g.addColorStop(0, `hsla(${h}, ${s}%, ${l + 10}%, ${0.28 * cur.glow})`)
        g.addColorStop(1, `hsla(${h}, ${s}%, ${l + 10}%, 0)`)
        ctx.fillStyle = g
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }

      // 扫描光带：横扫球体的一条光带，扫过时辉光短暂加强（雷达回波感）
      const scanY = (scanPhase / SCAN_PERIOD) * canvas.height
      const scanD = Math.abs(c - scanY) / (canvas.height / 2) // 0=正中 1=边缘
      const scanBoost = Math.max(0, 1 - scanD * 2.2) * 0.5
      const sg = ctx.createLinearGradient(0, scanY - 5 * dpr, 0, scanY + 5 * dpr)
      sg.addColorStop(0, `hsla(${h}, ${s}%, 90%, 0)`)
      sg.addColorStop(0.5, `hsla(${h}, ${s}%, 92%, ${(0.3 * cur.glow + scanBoost * 0.3).toFixed(3)})`)
      sg.addColorStop(1, `hsla(${h}, ${s}%, 90%, 0)`)
      ctx.fillStyle = sg
      ctx.fillRect(0, scanY - 5 * dpr, canvas.width, 10 * dpr)

      // 刻度弧（v0.2 仪器层）：24 段绕球一圈，隔段加长；相位驱动一道亮弧流动
      for (let i = 0; i < TICKS; i++) {
        const ta = (i / TICKS) * Math.PI * 2 - Math.PI / 2
        const long = i % 4 === 0
        const r0 = r + dpr * 1.2, r1 = r0 + (long ? 3 : 1.8) * dpr
        const flow = Math.max(0, Math.sin(phase - ta * 1.5)) // 亮弧随相位流动
        const ta2 = 0.06 + flow * 0.24 * cur.glow + scanBoost * 0.2
        ctx.strokeStyle = `hsla(${h}, ${s}%, ${Math.min(92, l + 14)}%, ${ta2.toFixed(3)})`
        ctx.lineWidth = Math.max(0.6, dpr * 0.7)
        ctx.beginPath()
        ctx.moveTo(c + Math.cos(ta) * r0, c + Math.sin(ta) * r0)
        ctx.lineTo(c + Math.cos(ta) * r1, c + Math.sin(ta) * r1)
        ctx.stroke()
      }

      // 身体：径向渐变玻璃球（中心偏上的高光 → 基色 → 边缘更深）
      // glitch 帧整体偏移 jx，并在原位留一道瞬间残影
      if (jump !== 0) {
        const ghost = ctx.createRadialGradient(c - r * 0.25, c - r * 0.3, r * 0.1, c, c, r)
        ghost.addColorStop(0, `hsla(${h}, ${s * 0.8}%, ${Math.min(96, l + 16)}%, 0.18)`)
        ghost.addColorStop(1, `hsla(${h}, ${s}%, ${l - 16}%, 0.05)`)
        ctx.beginPath()
        ctx.arc(c, c, r, 0, Math.PI * 2)
        ctx.fillStyle = ghost
        ctx.fill()
      }
      const bx = c + jx
      const body = ctx.createRadialGradient(bx - r * 0.25, c - r * 0.3, r * 0.1, bx, c, r)
      body.addColorStop(0, `hsla(${h}, ${s * 0.8}%, ${Math.min(96, l + 16)}%, 0.95)`)
      body.addColorStop(0.55, `hsl(${h}, ${s}%, ${l}%)`)
      body.addColorStop(1, `hsl(${h}, ${s}%, ${l - 16}%)`)
      ctx.beginPath()
      ctx.arc(bx, c, r, 0, Math.PI * 2)
      ctx.fillStyle = body
      ctx.fill()

      // 内在：两枚光斑沿各自轨道漂移，drift 决定游速与游幅（情绪的「活动」就住在这里）
      // 扫描光带经过时局部提亮；glitch 帧跟随身体偏移
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 2; i++) {
        const a = phase * (0.6 + i * 0.35) + i * 2.6
        const orbit = r * (0.18 + 0.3 * cur.drift)
        const px = bx + Math.cos(a) * orbit
        const py = c + Math.sin(a * 0.85 + i) * orbit * 0.8
        const near = scanBoost * (1 - Math.min(1, Math.abs(py - scanY) / (6 * dpr)))
        const br = r * (0.34 - i * 0.08)
        const bg = ctx.createRadialGradient(px, py, 0, px, py, br)
        bg.addColorStop(0, `hsla(${h + 18}, ${s}%, ${Math.min(92, l + 20)}%, ${(0.5 - i * 0.14 + near * 0.3).toFixed(3)})`)
        bg.addColorStop(1, `hsla(${h + 18}, ${s}%, ${l + 20}%, 0)`)
        ctx.fillStyle = bg
        ctx.beginPath()
        ctx.arc(px, py, br, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'

      // 暗核：低落/压力时内在更沉（吸收感）
      if (cur.depth > 0.02) {
        const dk = ctx.createRadialGradient(bx, c + r * 0.15, 0, bx, c + r * 0.15, r * 0.9)
        dk.addColorStop(0, `rgba(12, 10, 24, ${0.42 * cur.depth})`)
        dk.addColorStop(1, 'rgba(12, 10, 24, 0)')
        ctx.fillStyle = dk
        ctx.beginPath()
        ctx.arc(bx, c, r, 0, Math.PI * 2)
        ctx.fill()
      }

      // fresnel 细环：一条干净的边界，不是一圈粗环
      ctx.beginPath()
      ctx.arc(bx, c, r, 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(${h}, ${s}%, 88%, ${0.3 + 0.25 * cur.glow})`
      ctx.lineWidth = Math.max(1, dpr * 0.75)
      ctx.stroke()
    }

    const frame = (now: number) => {
      if (!alive) return
      if (document.hidden) { raf = 0; return } // 隐藏页签暂停，恢复由 visibilitychange 接管
      draw(now)
      raf = requestAnimationFrame(frame)
    }
    const onVis = () => {
      if (!alive || reduced) return
      if (!document.hidden && raf === 0) { last = performance.now(); raf = requestAnimationFrame(frame) }
    }
    document.addEventListener('visibilitychange', onVis)

    if (reduced) {
      draw(performance.now()) // 静态化：只画一帧（色相/明度仍忠实反映当下情绪）
    } else {
      raf = requestAnimationFrame(frame)
    }
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [size])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block', borderRadius: '50%' }}
      role="img"
      aria-label={label || '小语当前情绪'}
    />
  )
}
