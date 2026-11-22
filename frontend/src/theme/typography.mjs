// 字体排版（2026-11-22，用户反馈：主题系统里要能调字号、字间距）
// 按设备存本地，不跟服务端同步：手机和电脑屏幕不一样，要的字号本来就不同。
//   scale         界面缩放（整个工作台一起放大缩小；大部分尺寸写死 px，只能用 zoom）
//   chatSize      对话正文字号 px
//   letterSpacing 对话正文字间距 em
//   lineHeight    对话正文行高
// 写成 <html> 上的 CSS 变量，styles.css 里 .markdown-body 和用户气泡读它们。

const KEY = 'pi_typography'

export const TYPO_DEFAULTS = Object.freeze({ scale: 1, chatSize: 14, letterSpacing: 0, lineHeight: 1.76 })
export const TYPO_LIMITS = Object.freeze({
  scale: [0.85, 1.3, 0.05],
  chatSize: [12, 22, 1],
  letterSpacing: [0, 0.12, 0.01],
  lineHeight: [1.4, 2.2, 0.02],
})

function clamp(key, v) {
  const [min, max, step] = TYPO_LIMITS[key]
  const n = Number(v)
  if (!Number.isFinite(n)) return TYPO_DEFAULTS[key]
  const snapped = Math.round((n - min) / step) * step + min
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(3))
}

export function normalizeTypography(raw) {
  const out = { ...TYPO_DEFAULTS }
  if (raw && typeof raw === 'object') for (const k of Object.keys(TYPO_DEFAULTS)) if (raw[k] != null) out[k] = clamp(k, raw[k])
  return out
}

export function getTypography() {
  try { return normalizeTypography(JSON.parse(localStorage.getItem(KEY) || 'null')) } catch { return { ...TYPO_DEFAULTS } }
}

export function typographyVars(t) {
  const v = normalizeTypography(t)
  return {
    '--pi-ui-zoom': String(v.scale),
    '--pi-chat-size': `${v.chatSize}px`,
    '--pi-chat-tracking': `${v.letterSpacing}em`,
    '--pi-chat-leading': String(v.lineHeight),
  }
}

export function applyTypography(t = getTypography()) {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  for (const [k, val] of Object.entries(typographyVars(t))) el.style.setProperty(k, val)
  const scale = normalizeTypography(t).scale
  // 手机 App：走 WebView 原生文字缩放（CSS zoom 会连 vw/vh 一起放大，弹窗撑出屏幕）
  const native = globalThis.YuanshuDisplay
  if (native?.textZoom) {
    try { native.textZoom(Math.round(scale * 100)) } catch {}
    delete el.dataset.zoom
    return
  }
  // 缩放为 1 时不挂 data-zoom，完全不碰布局
  if (scale !== 1) el.dataset.zoom = '1'; else delete el.dataset.zoom
}

// patch 只改给到的字段；传 null 恢复全部默认
export function setTypography(patch) {
  const next = patch === null ? { ...TYPO_DEFAULTS } : normalizeTypography({ ...getTypography(), ...patch })
  try {
    if (patch === null) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  applyTypography(next)
  return next
}
