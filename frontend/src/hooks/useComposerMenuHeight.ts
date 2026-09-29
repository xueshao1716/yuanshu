import { useLayoutEffect, useState, type RefObject } from 'react'

// The composer moves when a mobile keyboard opens. Bound upward menus by the
// actual visible/clipped area, not a fixed height that can leave items offscreen.
export function useComposerMenuHeight(root: RefObject<HTMLDivElement | null>, open: boolean) {
  const [height, setHeight] = useState(224)
  useLayoutEffect(() => {
    const el = root.current
    if (!open || !el) return
    const measure = () => {
      let top = window.visualViewport?.offsetTop || 0
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (/hidden|clip|auto|scroll/.test(getComputedStyle(parent).overflowY)) {
          top = Math.max(top, parent.getBoundingClientRect().top)
        }
      }
      setHeight(Math.min(224, Math.max(44, el.getBoundingClientRect().top - top - 8)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('resize', measure)
    window.visualViewport?.addEventListener('scroll', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('scroll', measure)
    }
  }, [root, open])
  return height
}
