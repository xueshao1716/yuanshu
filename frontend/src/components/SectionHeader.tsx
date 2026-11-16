import { useId, useState, type ReactNode } from 'react'
import { CircleHelp, type LucideIcon } from 'lucide-react'

export type SectionHeaderProps = {
  title: string
  description?: string
  icon?: LucideIcon
  actions?: ReactNode
}

// 2026-11-16：区块说明默认收进标题旁的「？」——一屏六个区块各挂一段解释，页面就成了说明书。
// 悬停看 title，点开在标题下展开；第一次来的人找得到，天天用的人不用每次读。
export default function SectionHeader({ title, description, icon: Icon, actions }: SectionHeaderProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <header className="section-header">
      <div className="section-header__content">
        <div className="section-header__title-row">
          {Icon && <Icon className="section-header__icon" aria-hidden="true" />}
          <h2 className="section-header__title">{title}</h2>
          {description && (
            <button
              type="button"
              className="section-header__hint"
              aria-expanded={open}
              aria-controls={id}
              aria-label={`${title}：${open ? '收起说明' : '查看说明'}`}
              title={open ? undefined : description}
              onClick={() => setOpen(v => !v)}
            >
              <CircleHelp aria-hidden="true" />
            </button>
          )}
        </div>
        {description && open && <p id={id} className="section-header__description">{description}</p>}
      </div>
      {actions && <div className="section-header__actions">{actions}</div>}
    </header>
  )
}
