// 省电显示（2026-11-19）
// 新电脑没装显卡驱动时（"Microsoft 基本显示适配器"），WebView2 只能用 CPU 软件渲染：
// 毛玻璃 / SVG 折射 / 逐帧动画每一帧都靠 CPU 硬算，两个 webview 进程能吃到 129% + 74%，
// 连带后端健康检查超时。这里检测软件渲染，命中就给 <html> 打上 data-lite：
// CSS 去掉 backdrop-filter 和常驻动画，各动画组件按"减少动画"处理（只画一帧）。
// 偏好存 localStorage：auto（默认，按检测）/ on / off。

const KEY = 'pi_lite_mode'
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i

export function getLitePref() {
  try { const v = localStorage.getItem(KEY); return v === 'on' || v === 'off' ? v : 'auto' } catch { return 'auto' }
}

let detected = null
// 软件渲染检测：要求"无明显性能折扣"的 WebGL 拿不到、或渲染器名字是软件实现 → 视为软件渲染
export function detectSoftwareRender(doc = typeof document !== 'undefined' ? document : null) {
  if (detected !== null) return detected
  detected = false
  if (!doc) return detected
  try {
    const c = doc.createElement('canvas')
    const strict = c.getContext('webgl', { failIfMajorPerformanceCaveat: true })
    if (!strict) {
      const loose = doc.createElement('canvas').getContext('webgl')
      detected = !!loose // 普通 WebGL 有、"无折扣" WebGL 没有 = 软件渲染；两个都没有就不判（可能是禁用了 WebGL）
      loose?.getExtension('WEBGL_lose_context')?.loseContext()
    } else {
      const info = strict.getExtension('WEBGL_debug_renderer_info')
      const name = info ? String(strict.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : ''
      detected = SOFTWARE_RE.test(name)
      strict.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch { detected = false }
  return detected
}

export function isLite() {
  return typeof document !== 'undefined' && document.documentElement.dataset.lite === '1'
}

// 各动画组件用它代替单独的 prefers-reduced-motion 判断
export function lessMotion() {
  if (isLite()) return true
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function applyLiteMode(pref = getLitePref()) {
  const on = pref === 'on' || (pref === 'auto' && detectSoftwareRender())
  const el = document.documentElement
  if (on) el.dataset.lite = '1'; else delete el.dataset.lite
  return on
}

// 切换后动画组件只在挂载时读一次，所以设置页切换后提示刷新
export function setLitePref(pref) {
  try { if (pref === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, pref) } catch {}
  return applyLiteMode(pref)
}
