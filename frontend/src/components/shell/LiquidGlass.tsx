import { useEffect, type RefObject } from 'react'
import { buildLiquidFilter, refractionSupported } from '../../lib/liquid-glass.mjs'

// 给一个元素挂上液态玻璃折射（2026-11-17）。元素本身要带 .liquid-glass（毛玻璃 + 高光，全浏览器）；
// 这里只在 Chromium 上额外叠 SVG 折射，尺寸变了就按新尺寸重生成滤镜。
let seq = 0
let host: SVGSVGElement | null = null

function defs(): SVGSVGElement {
  if (host?.isConnected) return host
  host = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  host.setAttribute('aria-hidden', 'true')
  host.setAttribute('width', '0')
  host.setAttribute('height', '0')
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
  document.body.appendChild(host)
  return host
}

const reducedTransparency = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-transparency: reduce)').matches

// target 可以是 ref，也可以是元素本身（弹窗这类晚挂载的，用回调 ref 存进 state 再传进来）
export function useLiquidGlass(target: RefObject<HTMLElement | null> | HTMLElement | null, { radius = 16, strength = 1, blur = 10, active = true } = {}) {
  useEffect(() => {
    const el: HTMLElement | null = target instanceof HTMLElement ? target : target?.current ?? null
    if (!el || !active || !refractionSupported() || reducedTransparency()) return
    const id = `pi-lg-${++seq}`
    let last = '', frame = 0
    const apply = () => {
      frame = 0
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight)
      if (!w || !h) return
      const size = `${w}x${h}`
      if (size === last) return
      last = size
      defs().querySelector(`#${id}`)?.remove()
      defs().insertAdjacentHTML('beforeend', buildLiquidFilter(id, w, h, radius, strength))
      const value = `url(#${id}) blur(${blur}px) saturate(1.6)`
      el.style.setProperty('backdrop-filter', value)
      el.style.setProperty('-webkit-backdrop-filter', value)
    }
    const ro = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(apply) })
    ro.observe(el)
    apply()
    return () => {
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
      defs().querySelector(`#${id}`)?.remove()
      el.style.removeProperty('backdrop-filter')
      el.style.removeProperty('-webkit-backdrop-filter')
    }
  }, [target, radius, strength, blur, active])
}
