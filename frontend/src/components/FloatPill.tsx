import type { CSSProperties, ReactNode } from 'react'

// 悬浮药丸（2026-09-16，用户给的参考图："3colors combination" 那种一层层浮起来的胶囊按钮）。
//
// 它和普通按钮的差别不在圆角，而在**投影**：投影带着自己这枚药丸的颜色（同色系、低透明度、
// 偏下偏移），于是看上去是"浮"在底上，而不是贴了一层灰边。参考图里那几个彩色胶囊就是这么来的。
//
// 用法上它是个**展示 + 可点**的通用件：配色卡、筛选芯片、动作按钮都能用。
// 颜色走 CSS 变量（--float-bg / --float-fg / --float-tint），所以换一套色卡只是换变量。
export function FloatPill({ label, value, tint, bg, fg, active = false, disabled = false, title, onClick, className = '', children }: {
  label?: ReactNode
  value?: ReactNode
  tint?: string
  bg?: string
  fg?: string
  active?: boolean
  disabled?: boolean
  title?: string
  onClick?: () => void
  className?: string
  children?: ReactNode
}) {
  const style: CSSProperties = {}
  if (bg) (style as any)['--float-bg'] = bg
  if (fg) (style as any)['--float-fg'] = fg
  if (tint) (style as any)['--float-tint'] = tint
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      data-active={active ? 'true' : undefined}
      className={`float-pill ${className}`}
      style={style}
    >
      <span className="float-pill-dot" aria-hidden="true" />
      <span className="float-pill-text">
        {label && <span className="float-pill-label">{label}</span>}
        {value && <span className="float-pill-value">{value}</span>}
        {children}
      </span>
    </button>
  )
}

export default FloatPill
