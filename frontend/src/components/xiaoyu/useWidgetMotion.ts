import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { clampPosition, movedEnough, normalizeMode } from './widget-state.mjs'
import type { Point } from './widget-state.mjs'

export function readPreference(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
export function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* Storage can be unavailable in private WebViews. */ }
}
const viewport = () => ({ width: window.visualViewport?.width || window.innerWidth, height: window.visualViewport?.height || window.innerHeight })
const home = () => clampPosition({ x: viewport().width - 108, y: viewport().height - 230 }, viewport())

export function useWidgetMotion(paused: boolean) {
  const [view, setView] = useState(viewport)
  const [mode, setModeState] = useState(() => normalizeMode(readPreference('xiaoyu_mode')))
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [position, setPosition] = useState(() => {
    try { const p = JSON.parse(readPreference('xiaoyu_pos') || 'null'); return p ? clampPosition(p, viewport()) : home() } catch { return home() }
  })
  const point = useRef(position)
  const [dragged, setDragged] = useState(false)
  const [walking, setWalking] = useState(false)
  const [face, setFace] = useState(1)
  const drag = useRef<{ start: Point; offset: Point; moved: boolean; id: number } | null>(null)
  const suppressClick = useRef(false)
  const move = (p: Point) => { point.current = p; setPosition(p) }

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(mq.matches)
    const resize = () => { setView(viewport()); move(clampPosition(point.current, viewport())) }
    mq.addEventListener('change', change)
    window.addEventListener('resize', resize)
    window.visualViewport?.addEventListener('resize', resize)
    return () => { mq.removeEventListener('change', change); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize) }
  }, [])

  useEffect(() => {
    setWalking(false)
    if (mode !== 'roam' || paused || reduced || dragged) return
    let raf = 0, prev = performance.now(), restUntil = prev + 1600
    let target = point.current
    const step = (now: number) => {
      const dt = Math.min((now - prev) / 1000, .05); prev = now
      if (!document.hidden && now >= restUntil) {
        const p = point.current, distance = Math.hypot(target.x - p.x, target.y - p.y)
        if (distance < 2) {
          setWalking(false)
          target = clampPosition({ x: p.x + (Math.random() - .5) * 280, y: p.y + (Math.random() - .5) * 100 }, viewport())
          restUntil = now + 2200
        } else {
          setWalking(true)
          const step = Math.min(distance, dt * 24)
          if (Math.abs(target.x - p.x) > 2) setFace(target.x > p.x ? 1 : -1)
          move(clampPosition({ x: p.x + (target.x - p.x) / distance * step, y: p.y + (target.y - p.y) / distance * step }, viewport()))
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [mode, paused, reduced, dragged, view.width, view.height])

  const setMode = (next: 'corner' | 'roam') => {
    setModeState(next); savePreference('xiaoyu_mode', next)
    if (next === 'corner') setFace(1)
  }
  const reset = () => { setMode('corner'); move(home()); savePreference('xiaoyu_pos', JSON.stringify(point.current)) }
  const finish = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null; setDragged(false)
    if (d.moved) { suppressClick.current = true; savePreference('xiaoyu_pos', JSON.stringify(point.current)) }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  return {
    position, view, mode, reduced, dragged, walking, face, setMode, reset,
    consumeDrag: () => { const skip = suppressClick.current; suppressClick.current = false; return skip },
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        if (!e.isPrimary || e.button !== 0) return
        suppressClick.current = false
        drag.current = { start: { x: e.clientX, y: e.clientY }, offset: { x: e.clientX - point.current.x, y: e.clientY - point.current.y }, moved: false, id: e.pointerId }
        e.currentTarget.setPointerCapture(e.pointerId)
      },
      onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId) return
        d.moved ||= movedEnough(d.start, { x: e.clientX, y: e.clientY })
        if (!d.moved) return
        setDragged(true)
        move(clampPosition({ x: e.clientX - d.offset.x, y: e.clientY - d.offset.y }, viewport()))
      },
      onPointerUp: finish, onPointerCancel: finish, onLostPointerCapture: finish,
    },
  }
}
