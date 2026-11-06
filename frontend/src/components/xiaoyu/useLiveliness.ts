import { useEffect, useRef, useState } from 'react'
import type { CompanionAction } from './companion-state.mjs'

/**
 * 让人物"活起来"（2026-11-06）
 *
 * 问题：公仔只是换图（静候/工作中/挥手…），动作之间是硬切，看起来像贴纸。
 * 这里补的是**动作之间的连续小动作**，不依赖新素材：
 *   ① 视线跟随：鼠标/手指在哪，身体就轻微朝那边偏一点（视差 + 微旋）
 *   ② 眨眼：每隔几秒眨眼一次（有闭眼素材就切图，没有就压缩一下眼睛区域的高度）
 *   ③ 呼吸 + 微摆：连续的正弦曲线，不是"挺着不动"
 *   ④ 小动作：偶尔伸懒腰/东张西望一小会儿，再自己回到当前状态
 *   ⑤ 反应：新消息/开始说话时，先弹一下再进入状态
 *
 * 全部基于 transform/opacity，不重排；尊重 reduced-motion。
 */
export type LiveState = {
  tiltX: number      // -1..1 水平偏移
  tiltY: number      // -1..1 垂直偏移
  blinking: boolean
  gesture: CompanionAction | null
}

const pickIdleGestures: CompanionAction[] = ['stretch', 'lookaround', 'wave']

export function useLiveliness(action: CompanionAction, enabled = true) {
  const [state, setState] = useState<LiveState>({ tiltX: 0, tiltY: 0, blinking: false, gesture: null })
  const pointer = useRef({ x: 0.5, y: 0.5 })
  const reduced = useRef(false)

  // ① 视线跟随：记录全局指针位置（归一化到 0..1）
  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return
    try { reduced.current = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true } catch {}
    const onMove = (e: PointerEvent) => {
      const w = window.innerWidth || 1
      const h = window.innerHeight || 1
      pointer.current = { x: Math.min(1, Math.max(0, e.clientX / w)), y: Math.min(1, Math.max(0, e.clientY / h)) }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [enabled])

  // ② 视线 → 倾斜；用 60fps 的主循环同时驱动呼吸相位
  useEffect(() => {
    if (!enabled || reduced.current) return
    let raf = 0
    const tick = () => {
      const { x, y } = pointer.current
      // 以屏幕中心为界，人物朝指针方向偏，幅度很小（像"看过去"而不是"躲开"）
      const tiltX = (x - 0.5) * 2
      const tiltY = (y - 0.5) * 2
      setState(prev => (Math.abs(prev.tiltX - tiltX) < 0.02 && Math.abs(prev.tiltY - tiltY) < 0.02
        ? prev
        : { ...prev, tiltX, tiltY }))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [enabled])

  // ③ 眨眼：随机 3~8 秒一次，每次 120ms
  useEffect(() => {
    if (!enabled || reduced.current) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        setState(s => ({ ...s, blinking: true }))
        window.setTimeout(() => setState(s => ({ ...s, blinking: false })), 120)
        schedule()
      }, 3000 + Math.random() * 5000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [enabled])

  // ④ 偶发小动作：静候时才做，做 1.6 秒自己回位
  useEffect(() => {
    if (!enabled || reduced.current) return
    if (action !== 'neutral' && action !== 'daydreaming') return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        const g = pickIdleGestures[Math.floor(Math.random() * pickIdleGestures.length)]
        setState(s => ({ ...s, gesture: g }))
        window.setTimeout(() => setState(s => ({ ...s, gesture: null })), 1600)
        schedule()
      }, 18000 + Math.random() * 22000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [enabled, action])

  // ⑤ 状态切换时先"弹一下"（由 CSS 的 data-bump 驱动）
  const [bump, setBump] = useState(0)
  const prevAction = useRef(action)
  useEffect(() => {
    if (prevAction.current !== action) {
      prevAction.current = action
      setBump(b => b + 1)
    }
  }, [action])

  return { ...state, bump }
}
