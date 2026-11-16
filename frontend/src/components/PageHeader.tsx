import type { ReactNode } from 'react'

export type PageHeaderProps = {
  title: string
  description?: string
  actions?: ReactNode
  meta?: ReactNode
}

export default function PageHeader({ title, description, actions, meta }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__content">
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-header__description" title={description}>{description}</p>}
        {meta && <div className="page-header__meta">{meta}</div>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
