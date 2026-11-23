// ── 主题色同步给安卓原生「问小语」浮层（2026-11-23 v2.235.0）──
// 浮层是原生 Activity，不加载网页，拿不到 CSS 变量；每次主题生效后把几种关键颜色
// 解析成具体 #AARRGGBB 交给 window.YuanshuFlash.setTheme，原生存本地，卡片打开时读。
// 不在安卓 App 里（浏览器/桌面）时 YuanshuFlash 不存在，直接跳过。

const VARS: Record<string, string> = {
  bg: '--pi-panel-bg',
  border: '--pi-panel-border',
  field: '--pi-input-bg',
  fieldBorder: '--pi-input-border',
  text: '--pi-text',
  dim: '--pi-dim',
  accent: '--pi-accent',
  onAccent: '--pi-on-accent',
  btn: '--pi-btn-bg',
  danger: '--pi-danger',
}

let timer = 0

function toArgb(css: string): string | null {
  // color-mix() 算出来是 color(srgb 0.1 0.2 0.3 / 0.5)，分量 0~1
  const s = css.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)/)
  if (s) css = `rgba(${+s[1] * 255}, ${+s[2] * 255}, ${+s[3] * 255}, ${s[4] ?? 1})`
  const m = css.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/)
  if (!m) return null
  let a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
  a = Math.max(0, Math.min(1, a))
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  return '#' + hex(a * 255) + hex(+m[1]) + hex(+m[2]) + hex(+m[3])
}

function push() {
  const bridge = (window as any).YuanshuFlash
  if (!bridge || typeof bridge.setTheme !== 'function' || !document.body) return
  // 用一个探针元素让浏览器把 var()/color-mix 等都算成 rgb()，再转 #AARRGGBB
  const probe = document.createElement('span')
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const out: Record<string, string> = {}
  try {
    for (const [key, name] of Object.entries(VARS)) {
      probe.style.color = ''
      probe.style.color = `var(${name})`
      const v = toArgb(getComputedStyle(probe).color)
      if (v) out[key] = v
    }
  } finally { probe.remove() }
  if (!out.bg || !out.text || !out.accent) return
  try { bridge.setTheme(JSON.stringify(out)) } catch {}
}

// 主题页拖滑块时会连续触发，合并一下
export function syncNativeTheme() {
  if (typeof window === 'undefined' || !(window as any).YuanshuFlash) return
  window.clearTimeout(timer)
  timer = window.setTimeout(push, 250)
}
