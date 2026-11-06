import { useEffect, useRef, type ReactNode } from 'react'
import { Activity, ChevronsLeftRight, ClipboardCheck, FolderKanban, GitCompare, PackageCheck, PanelRightClose, TerminalSquare, X } from 'lucide-react'
import type { UtilityPanelKey } from '../shell/MobileMoreMenu'

const PANEL_TABS: { key: UtilityPanelKey; label: string; description: string; shortcut: string; icon: typeof Activity }[] = [
  { key: 'inspect', label: '检查', description: '查看运行状态、改动和验收', shortcut: 'Alt+1', icon: ClipboardCheck },
  { key: 'workspace', label: '工作区', description: '浏览文件、预览内容并交付', shortcut: 'Alt+2', icon: FolderKanban },
  { key: 'deliveries', label: '交付物', description: '查看最近生成和交付的文件', shortcut: 'Alt+3', icon: PackageCheck },
  { key: 'terminal', label: '终端', description: '在当前工作区执行命令', shortcut: 'Alt+4', icon: TerminalSquare },
  { key: 'activity', label: '活动', description: '查看小语最近的执行轨迹', shortcut: 'Alt+5', icon: Activity },
  { key: 'tui', label: 'TUI', description: '接管完整的终端界面', shortcut: 'Alt+6', icon: ChevronsLeftRight },
]

export default function UtilityPanel({ active, onChange, onClose, expanded, onToggleExpanded, onOpenReview, children }: {
  active: UtilityPanelKey
  onChange: (active: UtilityPanelKey) => void
  onClose: () => void
  expanded: boolean
  onToggleExpanded: () => void
  onOpenReview?: () => void
  children: ReactNode
}) {
  const canExpand = active === 'terminal' || active === 'tui'
  const activeTab = PANEL_TABS.find(tab => tab.key === active) || PANEL_TABS[0]
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        const next = PANEL_TABS[Number(e.key) - 1]
        if (next) onChange(next.key)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onChange, onClose])

  useEffect(() => {
    if (!canExpand && expanded) onToggleExpanded()
  }, [canExpand, expanded, onToggleExpanded])

  return (
    <aside className={`utility-panel col-right flex min-h-0 flex-col ${expanded ? 'utility-panel-expanded' : ''}`} data-panel={active} aria-label="辅助工具面板">
      <header className="utility-panel-header flex flex-shrink-0 flex-col border-b border-pi-border-soft">
        <div className="utility-panel-heading flex items-center gap-2 px-3">
          <h2 className="utility-panel-title truncate flex-1" title={activeTab.description}>{activeTab.label}</h2>
          {onOpenReview && <button type="button" className="utility-panel-review btn-tool !h-9 !px-2" title="打开改动审查" aria-label="打开改动审查" onClick={onOpenReview}><GitCompare className="h-4 w-4" /></button>}
          {canExpand && (
            <button
              className="utility-panel-expand btn-tool !h-9 !w-9 !p-0"
              aria-label={expanded ? '退出展开视图' : '展开面板'}
              aria-expanded={expanded}
              title={expanded ? '退出展开视图' : '展开面板'}
              onClick={onToggleExpanded}
            >
              <ChevronsLeftRight className="h-4 w-4" />
            </button>
          )}
          <button className="btn-tool !h-9 !w-9 !p-0" aria-label="关闭辅助工具面板" title="关闭辅助工具面板" onClick={onClose}>
            {expanded ? <PanelRightClose className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </button>
        </div>
        <nav className="utility-panel-tabs flex min-w-0 items-center gap-1 px-2" role="tablist" aria-label="辅助面板类型">
          {PANEL_TABS.map((tab, index) => (
            <button
              key={tab.key}
              ref={element => { tabRefs.current[index] = element }}
              id={`utility-tab-${tab.key}`}
              role="tab"
              aria-label={tab.label}
              aria-selected={active === tab.key}
              aria-controls={`utility-panel-${tab.key}`}
              tabIndex={active === tab.key ? 0 : -1}
              title={`${tab.label}（${tab.shortcut}）`}
              className="utility-panel-tab"
              onClick={() => onChange(tab.key)}
              onKeyDown={event => {
                const count = PANEL_TABS.length
                const next = event.key === 'ArrowRight' ? (index + 1) % count : event.key === 'ArrowLeft' ? (index + count - 1) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1
                if (next < 0) return
                event.preventDefault()
                onChange(PANEL_TABS[next].key)
                tabRefs.current[next]?.focus()
              }}
            >
              <tab.icon className="h-4 w-4" strokeWidth={1.8} />
            </button>
          ))}
        </nav>
      </header>
      <div id={`utility-panel-${active}`} className="flex min-h-0 min-w-0 flex-1 flex-col" role="tabpanel" aria-labelledby={`utility-tab-${active}`}>{children}</div>
    </aside>
  )
}
