import { useEffect, type RefObject } from 'react'
import { isLite } from '../../lib/lite-mode.mjs'
import { buildLiquidFilter, refractionSupported, THEME_GLASS_SELECTORS, THEME_GLASS_MAX } from '../../lib/liquid-glass.mjs'

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
const canRefract = () => refractionSupported() && !reducedTransparency() && !isLite()

interface GlassOpts { radius?: number; strength?: number; blur?: number }

// 挂上折射，返回卸载函数。radius 不传就读元素自己的圆角。
export function attachLiquidGlass(el: HTMLElement, { radius, strength = 1, blur = 10 }: GlassOpts = {}): () => void {
  const id = `pi-lg-${++seq}`
  let last = '', frame = 0
  const apply = () => {
    frame = 0
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight)
    if (!w || !h) return
    const size = `${w}x${h}`
    if (size === last) return
    last = size
    const r = radius ?? (parseFloat(getComputedStyle(el).borderTopLeftRadius) || 12)
    defs().querySelector(`#${id}`)?.remove()
    defs().insertAdjacentHTML('beforeend', buildLiquidFilter(id, w, h, Math.min(r, h / 2), strength))
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
}

// target 可以是 ref，也可以是元素本身（弹窗这类晚挂载的，用回调 ref 存进 state 再传进来）
export function useLiquidGlass(target: RefObject<HTMLElement | null> | HTMLElement | null, { radius = 16, strength = 1, blur = 10, active = true } = {}) {
  useEffect(() => {
    const el: HTMLElement | null = target instanceof HTMLElement ? target : target?.current ?? null
    if (!el || !active || !canRefract()) return
    return attachLiquidGlass(el, { radius, strength, blur })
  }, [target, radius, strength, blur, active])
}

// 「液态玻璃」主题：选中该主题时，给 THEME_GLASS_SELECTORS 里的浮层控件自动挂折射；
// 页面切换/列表刷新出来的新元素也补挂，消失的卸掉；换走主题全部卸掉。
export function useThemeLiquidGlass() {
  useEffect(() => {
    if (!canRefract()) return
    const attached = new Map<HTMLElement, () => void>()
    const selector = THEME_GLASS_SELECTORS.join(',')
    let timer = 0
    const sync = () => {
      timer = 0
      const on = document.documentElement.dataset.theme === 'liquid-glass'
      const want = on ? Array.from(document.querySelectorAll<HTMLElement>(selector)).slice(0, THEME_GLASS_MAX) : []
      const keep = new Set(want)
      for (const [el, detach] of attached) if (!keep.has(el) || !el.isConnected) { detach(); attached.delete(el) }
      for (const el of want) if (!attached.has(el)) attached.set(el, attachLiquidGlass(el, { strength: 0.7, blur: 12 }))
    }
    const schedule = () => { if (!timer) timer = window.setTimeout(sync, 250) }
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true })
    const themeMo = new MutationObserver(schedule)
    themeMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    sync()
    return () => {
      mo.disconnect(); themeMo.disconnect()
      if (timer) clearTimeout(timer)
      for (const detach of attached.values()) detach()
      attached.clear()
    }
  }, [])
}
