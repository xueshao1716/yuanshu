import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export type StatusTileProps = {
  label: string
  value: ReactNode
  /** 单行说明（兼容旧用法） */
  detail?: string
  /** 多条键值说明：需要把"哪一项是什么"讲清楚时用它（如版本 / 运行时 / 平台） */
  facts?: { k: string; v: ReactNode }[]
  icon: LucideIcon
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'
}

export default function StatusTile({ label, value, detail, facts, icon: Icon, tone = 'neutral' }: StatusTileProps) {
  const rows = facts?.filter((f) => f && f.v !== undefined && f.v !== null && f.v !== '') || []
  return (
    <div className="status-tile" data-tone={tone}>
      <div className="status-tile__icon" aria-hidden="true"><Icon /></div>
      <div className="status-tile__content">
        <span className="status-tile__label">{label}</span>
        <strong className="status-tile__value">{value}</strong>
        {detail && <span className="status-tile__detail">{detail}</span>}
        {rows.length > 0 && (
          <dl className="status-tile__facts">
            {rows.map((f) => (
              <div key={f.k} className="status-tile__fact">
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  )
}
