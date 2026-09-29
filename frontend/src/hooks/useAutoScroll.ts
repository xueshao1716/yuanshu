import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const FOLLOW_BOTTOM_THRESHOLD_PX = 12
const PROGRAMMATIC_GUARD_MS = 150
const LAYOUT_GUARD_MS = 600

interface AutoScrollOptions {
  sessionKey?: string | number | null
  lastMessageKey?: string | null
  /** History loading is not an explicit send gesture. */
  lastFromUser?: boolean
}

export function useAutoScroll(opts: AutoScrollOptions) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)
  const programmaticUntilRef = useRef(0)
  const layoutGuardUntilRef = useRef(0)
  const frameRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  const sessionRef = useRef(opts.sessionKey)
  sessionRef.current = opts.sessionKey

  const cancelScroll = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
  }, [])
  const bindScroll = useCallback((node: HTMLDivElement | null) => {
    if (scrollRef.current === node) return
    cancelScroll()
    scrollRef.current = node
    setElement(node)
  }, [cancelScroll])
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_BOTTOM_THRESHOLD_PX
  }, [])
  const scrollToBottom = useCallback((force = false) => {
    if (force) {
      userScrolledRef.current = false
      layoutGuardUntilRef.current = 0
    }
    if (userScrolledRef.current || Date.now() < layoutGuardUntilRef.current) return
    const el = scrollRef.current, session = sessionRef.current
    if (!el || frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      // Intent and ownership can change after scheduling.
      if (scrollRef.current !== el || sessionRef.current !== session || userScrolledRef.current || Date.now() < layoutGuardUntilRef.current) return
      programmaticUntilRef.current = Date.now() + PROGRAMMATIC_GUARD_MS
      el.scrollTop = el.scrollHeight
      setAtBottom(true)
    })
  }, [])

  useLayoutEffect(() => {
    const el = element
    if (!el) return
    let lastTop = el.scrollTop, touchY: number | null = null
    const pause = () => { userScrolledRef.current = true; cancelScroll() }
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 || (e.deltaY > 0 && !isNearBottom())) pause()
    }
    const onPointerDown = () => {
      layoutGuardUntilRef.current = Date.now() + LAYOUT_GUARD_MS
      pause()
    }
    const onPointerUp = () => {
      if (isNearBottom()) { userScrolledRef.current = false; layoutGuardUntilRef.current = 0; scrollToBottom() }
    }
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; pause() }
    const onTouchMove = (e: TouchEvent) => {
      const next = e.touches[0]?.clientY
      if (touchY !== null && next !== undefined && next > touchY) pause()
      touchY = next ?? null
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key) || (e.key === ' ' && e.shiftKey)) pause()
    }
    const onScroll = () => {
      const near = isNearBottom(), movedUp = el.scrollTop < lastTop - 2
      const moved = Math.abs(el.scrollTop - lastTop) > 2
      lastTop = el.scrollTop
      setAtBottom(near)
      if (near) userScrolledRef.current = false
      else if (movedUp || (moved && Date.now() >= programmaticUntilRef.current)) pause()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    return () => {
      cancelScroll()
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [element, opts.sessionKey, cancelScroll, isNearBottom, scrollToBottom])

  useEffect(() => {
    if (!element || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => scrollToBottom())
    const observe = () => {
      ro.disconnect()
      ro.observe(element)
      for (const child of Array.from(element.children)) ro.observe(child)
      scrollToBottom()
    }
    observe()
    // Skeletons and message lists can replace the first child.
    const mo = new MutationObserver(observe)
    mo.observe(element, { childList: true })
    return () => { ro.disconnect(); mo.disconnect(); cancelScroll() }
  }, [element, scrollToBottom, cancelScroll])

  useEffect(() => { if (opts.lastMessageKey) scrollToBottom() }, [opts.lastMessageKey, scrollToBottom])
  useLayoutEffect(() => {
    cancelScroll()
    userScrolledRef.current = false
    layoutGuardUntilRef.current = 0
    setAtBottom(true)
    scrollToBottom()
    return cancelScroll
  }, [opts.sessionKey, scrollToBottom, cancelScroll])

  return { scrollRef, bindScroll, scrollToBottom, isNearBottom, atBottom }
}
