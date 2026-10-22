/**
 * 元枢 · 品牌标记（2026-10-22 换标）
 *
 * 形状：断口环 + 轴心点 + 一颗紫点（在断口处）。
 * 含义：枢 = 轴/门枢；断口表示"可开合、可转向"；紫点是轴心之外的「她」。
 *
 * 小尺寸（<24px）自动切简化版：去掉紫点、环加粗——16px 下紫点会糊成一坨。
 * 不做动画：旧版三条脉冲竖线在静止截图里像"信号强度"，新标静态更稳。
 */
type Props = {
  size?: number
  className?: string
  /** 环与轴心颜色，默认跟随 currentColor（便于放在彩色底上） */
  color?: string
  /** 紫点颜色；传 null 可强制不画 */
  satellite?: string | null
  title?: string
}

export default function BrandMark({
  size = 26,
  className = '',
  color = 'var(--brand-mark, #5468ff)',
  satellite = 'var(--brand-mark-2, #8b7cf6)',
  title = '元枢',
}: Props) {
  const simple = size < 24
  const stroke = simple ? (size <= 16 ? 10 : 7.5) : 3.4
  const showSat = !simple && satellite !== null
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label={title}
      className={className}
    >
      <circle
        cx="32" cy="32" r="21.5"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={simple ? undefined : '104 31'}
        transform="rotate(-52 32 32)"
      />
      <circle cx="32" cy="32" r={simple ? 9 : 7.6} fill={color} />
      {showSat && <circle cx="48.8" cy="15.2" r="4.4" fill={satellite} />}
    </svg>
  )
}
