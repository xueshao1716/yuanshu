import { useCallback, useEffect, useRef, useState } from 'react'

// 移动端下拉刷新（2026-08-26，对标原生 App 手感）
// 原理：监听滚动容器 touch 事件——仅在 scrollTop===0 时允许下拉；
// 拉动距离带阻尼（实际位移 ×0.4），超过阈值松手触发刷新；指示器用 --pi-ease 弹回。
// 实现要点：
//  - pull/refreshing 用 ref 做唯一事实源（touchend 不受渲染闭包陈旧值影响），state 只做渲染镜像
//  - 稳定回调仅在滚动容器更换时重绑，加载骨架/切会话不能遗留旧监听
//  - 仅触屏会触发 touch 事件，桌面无副作用

const TRIGGER_PX = 60 // 触发刷新的最小拉动距离
const MAX_PULL_PX = 96 // 指示器最大位移
const DAMPING = 0.4 // 阻尼系数：手指移动 100px → 指示器走 40px

export function usePullToRefresh(onRefresh: () => Promise<unknown> | void) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const bindContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node
    setElement(node)
  }, [])
  const [pull, setPull] = useState(0) // 渲染镜像
  const [refreshing, setRefreshing] = useState(false)
  const startY = useRef<number | null>(null)
  const pullRef = useRef(0)
  const refreshingRef = useRef(false)
  const cbRef = useRef(onRefresh)
  useEffect(() => { cbRef.current = onRefresh })

  // 稳定回调：内部一律读 ref，永不因状态变化重绑
  const onTouchStart = useCallback((e: TouchEvent) => {
    const el = containerRef.current
    if (!el || el.scrollTop > 0 || refreshingRef.current) return
    startY.current = e.touches[0]?.clientY ?? null
  }, [])

  const onTouchMove = useCallback((e: TouchEvent) => {
    if (startY.current === null || refreshingRef.current) return
    const el = containerRef.current
    if (!el || el.scrollTop > 0) { startY.current = null; if (pullRef.current) { pullRef.current = 0; setPull(0) } return }
    const dy = (e.touches[0]?.clientY ?? 0) - startY.current
    const d = dy <= 0 ? 0 : Math.min(Math.round(dy * DAMPING), MAX_PULL_PX)
    if (d !== pullRef.current) { pullRef.current = d; setPull(d) }
  }, [])

  const onTouchEnd = useCallback(async () => {
    if (startY.current === null) return
    startY.current = null
    const distance = pullRef.current
    if (distance >= TRIGGER_PX && !refreshingRef.current) {
      refreshingRef.current = true
      setRefreshing(true)
      pullRef.current = 36
      setPull(36) // 刷新中保持一个小高度
      try { await cbRef.current() } finally {
        refreshingRef.current = false
        setRefreshing(false)
        pullRef.current = 0
        setPull(0)
      }
    } else {
      pullRef.current = 0
      setPull(0) // 未达阈值，弹回
    }
  }, [])

  useEffect(() => {
    const el = element
    if (!el) return
    const opts: AddEventListenerOptions = { passive: true }
    el.addEventListener('touchstart', onTouchStart, opts)
    el.addEventListener('touchmove', onTouchMove, opts)
    el.addEventListener('touchend', onTouchEnd, opts)
    el.addEventListener('touchcancel', onTouchEnd, opts)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
      startY.current = null
      pullRef.current = 0
      setPull(0)
    }
  }, [element, onTouchStart, onTouchMove, onTouchEnd])

  /** 指示器应渲染的样式：锚定在头部下方，随拉动下移，松手弹回 */
  const indicatorStyle: React.CSSProperties = {
    transform: `translateY(${refreshing ? 10 : Math.max(pull - 44, -48)}px)`,
    opacity: refreshing ? 1 : pull > 10 ? 1 : 0,
    transition: 'transform .28s var(--pi-ease), opacity .2s',
  }
  const spin = refreshing

  return { containerRef, bindContainer, indicatorStyle, spin, armed: pull >= TRIGGER_PX }
}
