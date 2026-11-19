// GradientField —— 欢迎页空态的动态 3D 渐变氛围层（2026-09-03）
// 借鉴 Shader Gradient（ruucm/shadergradient，2249★）：Three.js+GLSL 动态渐变场，
// 「球=『我在』（MoodOrb），场=『环境』」——欢迎页是门户场景，适合铺环境光。
// 纪律：
// · lazy 拆块——three 只在被用到时下载，聊天主包零负担
// · 深色主题才渲染（浅色底下深色渐变不搭，回退无背景）；挂载时判定，不做实时响应
// · WebGL 预检，失败静默回退（欢迎页没有背景也成立）
// · pointer-events-none / aria-hidden，纯装饰不拦交互
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { lessMotion } from '../lib/lite-mode.mjs'

const Field = lazy(() => import('./ShaderGradientInner'))

// 读主题背景亮度：hex/rgb → 0..1，<0.45 视为深色主题
function isDarkTheme(): boolean {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--pi-bg').trim()
    const m = raw.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/)
    let r = 0, g = 0, b = 0
    if (m) { r = +m[1]; g = +m[2]; b = +m[3] }
    else {
      const hex = raw.replace('#', '')
      const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex
      if (full.length !== 6) return false
      r = parseInt(full.slice(0, 2), 16); g = parseInt(full.slice(2, 4), 16); b = parseInt(full.slice(4, 6), 16)
    }
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.45
  } catch { return false }
}

class FieldGuard extends Component<{ children: ReactNode }, { dead: boolean }> {
  state = { dead: false }
  static getDerivedStateFromError() { return { dead: true } }
  render() { return this.state.dead ? null : this.props.children }
}

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch { return false }
}

export default function GradientField() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (lessMotion()) return // 动效敏感用户：静态欢迎页
    if (!isDarkTheme() || !webglOk()) return
    setOn(true)
  }, [])
  if (!on) return null
  return (
    <div aria-hidden="true" className="gradient-field pointer-events-none absolute inset-0 overflow-hidden">
      <FieldGuard>
        <Suspense fallback={null}>
          <Field />
        </Suspense>
      </FieldGuard>
    </div>
  )
}
