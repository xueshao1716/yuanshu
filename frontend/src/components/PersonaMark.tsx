/**
 * 小语 · 人物标志（2026-10-25）。
 *
 * 为什么要有它：产品标志（BrandMark：断口环 + 轴心点）是**元枢**这个产品，
 * 而侧栏头部紧挨着的是**小语**这个"人"。两处用同一个图标，等于把产品和人混成一个东西。
 *
 * 形状取"说话"：圆角气泡 + 一道起伏的声线 + 左下角的气泡尾。
 * 为什么是说话：她的活儿是"对话与交付"，人物标志应该指向这个，而不是再画一个环。
 * 颜色用暖色（默认 --persona-mark），和产品的蓝紫拉开距离。
 *
 * 小尺寸（<24px）自动简化：去掉声线，只留气泡 + 尾巴——16px 下多一条线会糊成一团。
 */
type Props = {
  size?: number
  className?: string
  /** 气泡描边色，默认暖色；放在深色底上会自动跟随 currentColor */
  color?: string
  title?: string
}

export default function PersonaMark({
  size = 26,
  className = '',
  color = 'var(--persona-mark, #e8944a)',
  title = '小语',
}: Props) {
  const simple = size < 24
  const stroke = simple ? (size <= 16 ? 9 : 6.5) : 3.6
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
      {/* 气泡 */}
      <rect
        x="9" y="11" width="46" height="35" rx="13"
        stroke={color} strokeWidth={stroke} strokeLinejoin="round"
      />
      {/* 气泡尾：从气泡左下角斜切下来 */}
      <path
        d="M21 46 L17 56 L31 46"
        stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
      />
      {/* 声线：两段起伏，像说话时的语调 */}
      {!simple && (
        <path
          d="M21 29 C25 22, 29 22, 32 29 S39 36, 43 29"
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
        />
      )}
    </svg>
  )
}
