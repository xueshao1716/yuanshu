import { useState } from 'react'
import { Ellipsis } from 'lucide-react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import type { Route } from '../hooks/useHashRoute'
import { RAIL_MORE } from '../nav'

export default function DesktopMoreMenu({
  items,
  route,
  nav,
}: {
  items: { route: Route; icon: typeof Ellipsis; label: string }[]
  route: Route
  nav: (r: Route) => void
}) {
  const [open, setOpen] = useState(false)
  const moreActive = (RAIL_MORE as readonly string[]).includes(route)

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
      <button
        aria-label={moreActive ? `更多：${items.find(item => item.route === route)?.label || '更多'}` : '更多'}
        aria-expanded={open}
        aria-current={moreActive ? 'page' : undefined}
        title="更多"
        className={`desktop-rail-item rounded-pi-md flex items-center gap-2 relative transition-[background-color,color,border-color,box-shadow,transform] duration-200 ${
          moreActive || open ? 'bg-pi-accent text-pi-on-accent shadow-md shadow-pi-accent/25' : 'text-pi-dim2 hover:text-pi-text hover:bg-pi-bg3'}`}
      >
        <Ellipsis className="w-[18px] h-[18px]" strokeWidth={1.8} />
        <span className="desktop-rail-label">{items.find(item => item.route === route)?.label || '更多'}</span>
      </button>
      </Menu.Trigger>
      <Menu.Portal>
          <Menu.Content side="right" align="start" sideOffset={8} collisionPadding={8} className="z-50 panel p-1.5 flex flex-col gap-0.5 w-40">
            {items.map(n => (
              <Menu.Item
                key={n.route}
                aria-current={route === n.route ? 'page' : undefined}
                className={`flex items-center gap-2 px-3 min-h-11 rounded-pi-sm text-sm cursor-pointer data-[highlighted]:bg-pi-bg3 ${
                  route === n.route ? 'bg-pi-accent/10 text-pi-text' : 'text-pi-dim hover:bg-pi-bg3 hover:text-pi-text'}`}
                onSelect={() => nav(n.route)}
              >
                <n.icon className="w-4 h-4 flex-shrink-0" strokeWidth={1.8} />
                {n.label}
              </Menu.Item>
            ))}
          </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
