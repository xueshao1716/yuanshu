import { useEffect, useRef } from 'react'
import {
  Activity, BrainCircuit, ClipboardCheck, Cpu, Database, Download, Factory, FolderKanban,
  Globe2, LayoutDashboard, LayoutGrid, LogOut, MonitorCog, PackageCheck, Palette, PanelRight, Sparkles,
  TerminalSquare, X,
} from 'lucide-react'
import type { Route } from '../hooks/useHashRoute'
import { ROUTE_LABELS } from '../nav'

export type UtilityPanelKey = 'workspace' | 'deliveries' | 'terminal' | 'activity' | 'tui' | 'inspect'

// 手机底部栏只有 对话/会话/资产/任务/更多，工作台、创作、能力只在这里能到，不能删。
// 但「改动验收」不再单列：它已并入工作台作为页内视图（#/review 仍是深链别名），
// 和「工作台」并列就是同一个页面出现两次。
const MORE_ROUTES: { route: Route; icon: typeof Sparkles; label: string }[] = [
  { route: 'board', icon: LayoutDashboard, label: ROUTE_LABELS.board },
  { route: 'lingxi', icon: Sparkles, label: ROUTE_LABELS.lingxi },
  { route: 'workshop', icon: Factory, label: ROUTE_LABELS.workshop },
  { route: 'models', icon: BrainCircuit, label: ROUTE_LABELS.models },
  { route: 'apps', icon: LayoutGrid, label: ROUTE_LABELS.apps },
  { route: 'engine', icon: Cpu, label: ROUTE_LABELS.engine },
  { route: 'themes', icon: Palette, label: ROUTE_LABELS.themes },
  { route: 'sessiondb', icon: Database, label: ROUTE_LABELS.sessiondb },
  { route: 'downloads', icon: Download, label: ROUTE_LABELS.downloads },
  { route: 'system', icon: MonitorCog, label: ROUTE_LABELS.system },
]

const PANEL_ACTIONS: { panel: UtilityPanelKey; icon: typeof Sparkles; label: string }[] = [
  { panel: 'inspect', icon: ClipboardCheck, label: '任务检查' },
  { panel: 'workspace', icon: FolderKanban, label: '工作空间' },
  { panel: 'deliveries', icon: PackageCheck, label: '交付物' },
  { panel: 'terminal', icon: TerminalSquare, label: '终端' },
  { panel: 'activity', icon: Activity, label: '活动' },
  { panel: 'tui', icon: PanelRight, label: 'TUI' },
]

const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function MobileMoreMenu({ open, onClose, route, nav, onOpenPanel, onOpenTheme, onOpenBrowser, onLogout }: {
  open: boolean
  onClose: () => void
  route: Route
  nav: (route: Route) => void
  onOpenPanel: (panel: UtilityPanelKey) => void
  onOpenTheme: () => void
  onOpenBrowser: () => void
  onLogout: () => void
}) {
  const sheetRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const focusable = [...(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
        .filter(element => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true')
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const activeElement = document.activeElement
      if (e.shiftKey && (activeElement === focusable[0] || !sheetRef.current?.contains(activeElement))) {
        e.preventDefault()
        focusable[focusable.length - 1]?.focus()
      } else if (!e.shiftKey && (activeElement === focusable[focusable.length - 1] || !sheetRef.current?.contains(activeElement))) {
        e.preventDefault()
        focusable[0]?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const openRoute = (nextRoute: Route) => {
    onClose()
    if (nextRoute === 'themes') onOpenTheme()
    else nav(nextRoute)
  }

  return (
    <div className="fixed inset-0 z-[var(--pi-z-dialog)] flex items-end" role="presentation">
      <button className="absolute inset-0 bg-black/50" aria-label="关闭更多菜单" onClick={onClose} />
      <section
        ref={sheetRef}
        className="mobile-more-sheet relative w-full rounded-t-pi-xl border-t border-pi-border bg-pi-bg1 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-more-title"
      >
        <header className="flex min-h-12 items-center gap-3 border-b border-pi-border-soft px-4">
          <div>
            <h2 id="mobile-more-title" className="text-[15px] font-semibold text-pi-text">更多功能</h2>
            <p className="text-xs text-pi-dim">功能页面与辅助工具</p>
          </div>
          <button ref={closeButtonRef} className="mobile-more-action ml-auto !min-w-11 rounded-pi-md text-pi-dim hover:bg-pi-bg3 hover:text-pi-text" aria-label="关闭更多菜单" onClick={onClose}>
            <X className="h-[18px] w-[18px]" />
          </button>
        </header>

        <div className="max-h-[min(68vh,560px)] overflow-y-auto px-4 py-3">
          <p className="mb-2 text-[11px] font-medium text-pi-dim">功能页面</p>
          <div className="grid grid-cols-4 gap-2">
            {MORE_ROUTES.map(item => (
              <button
                key={item.route}
                className={`mobile-more-action flex-col gap-1 rounded-pi-md px-1 text-xs ${route === item.route ? 'bg-pi-accent/10 text-pi-text' : 'text-pi-dim hover:bg-pi-bg3 hover:text-pi-text'}`}
                aria-current={route === item.route ? 'page' : undefined}
                onClick={() => openRoute(item.route)}
              >
                <item.icon className="h-5 w-5" strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <div className="my-3 border-t border-pi-border-soft" />
          <p className="mb-2 text-[11px] font-medium text-pi-dim">辅助面板</p>
          <div className="grid grid-cols-2 gap-2">
            {PANEL_ACTIONS.map(item => (
              <button
                key={item.panel}
                className="mobile-more-action justify-start gap-2 rounded-pi-md bg-pi-bg2 px-3 text-xs text-pi-text hover:bg-pi-bg3"
                onClick={() => { onClose(); onOpenPanel(item.panel) }}
              >
                <item.icon className="h-[18px] w-[18px] text-pi-accent" strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>

          <button
            className="mobile-more-action mt-2 w-full justify-start gap-2 rounded-pi-md bg-pi-bg2 px-3 text-xs text-pi-text hover:bg-pi-bg3"
            onClick={() => { onClose(); onOpenBrowser() }}
          >
            <Globe2 className="h-[18px] w-[18px] text-pi-accent" strokeWidth={1.8} />
            <span>内置浏览器</span>
          </button>

          <div className="my-3 border-t border-pi-border-soft" />
          <button
            className="mobile-more-action w-full justify-start gap-2 rounded-pi-md px-3 text-xs text-pi-red hover:bg-pi-bg3"
            onClick={() => { onClose(); onLogout() }}
          >
            <LogOut className="h-[18px] w-[18px]" strokeWidth={1.8} />
            <span>退出登录</span>
          </button>
        </div>
      </section>
    </div>
  )
}
