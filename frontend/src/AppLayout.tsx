import { Suspense, lazy, useCallback, useEffect, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { MessagesSquare, BrainCircuit, Images, Clock4, Download, LayoutGrid, LayoutDashboard, Settings2, FolderClosed, PanelLeftOpen, Sparkles, Factory, MonitorCog, Cpu, Palette, Database, GitCompare, LogOut, Ellipsis } from 'lucide-react'
import { useApp } from './store'
import { useIsMobile } from './hooks/useIsMobile'
import { useHashRoute, PageErrorBoundary, type Route } from './hooks/useHashRoute'
import Login from './components/Login'
import TitleBar from './components/TitleBar'
import SetupWizard from './components/SetupWizard'
import { KeysApi } from './api'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import ThemeSwitcher from './components/ThemeSwitcher'
import CommandPalette from './components/CommandPalette'
import MobileMoreMenu, { type UtilityPanelKey } from './components/MobileMoreMenu'
import DesktopMoreMenu from './components/DesktopMoreMenu'
import UtilityPanel from './components/UtilityPanel'
import { RAIL_MORE, RAIL_PRIMARY, ROUTE_LABELS } from './nav'
import * as T from '@radix-ui/react-tooltip'
import { applyWallpaper, currentWallpaper } from './theme/wallpaper.mjs'
import { installVisualViewportHeight } from './lib/viewport'
import { useThemePreferences } from './hooks/useThemePreferences'

// 页面 lazy（路线图：每路由 lazy + ErrorBoundary）
const ModelHub = lazy(() => import('./pages/ModelHub'))
const Assets = lazy(() => import('./pages/Assets'))
const Tasks = lazy(() => import('./pages/Tasks'))
const Downloads = lazy(() => import('./pages/Downloads'))
const Apps = lazy(() => import('./pages/Apps'))
const EnginePage = lazy(() => import('./pages/Engine'))
const LingXiPage = lazy(() => import('./pages/LingXi'))
const BoardPage = lazy(() => import('./pages/Board'))
const SystemPage = lazy(() => import('./pages/System'))
const ThemesPage = lazy(() => import('./pages/Themes'))
const SessionDbPage = lazy(() => import('./pages/SessionDb'))
const WorkshopPage = lazy(() => import('./pages/Workshop'))
const TuiTerminal = lazy(() => import('./components/TuiTerminal'))
const WorkSpace = lazy(() => import('./components/Workspace'))
const Deliveries = lazy(() => import('./components/Deliveries'))
const TerminalPanel = lazy(() => import('./components/TerminalPanel'))
const LazyModelManager = lazy(() => import('./components/ModelManager'))
const ActivityFeed = lazy(() => import('./components/ActivityFeed'))
const TaskInspector = lazy(() => import('./components/TaskInspector'))

// 深链别名：#/review 渲染工作台并把视图预设为「改动验收」
function BoardReviewPage() {
  return <BoardPage initialView="review" />
}

// 深链别名：#/story 渲染创作并把 tab 预设为「连续创作」
function WorkshopStoryPage() {
  return <WorkshopPage initialTab="story" />
}

type PageRoute = {
  route: Exclude<Route, 'chat'>
  icon: typeof MessagesSquare
  label: string
  Page: ComponentType<any>
  nav?: boolean
}

// 页面注册表是路由、页面渲染和桌面导航的单一来源；移动端导航是刻意不同的信息架构。
const PAGE_ROUTES: PageRoute[] = [
  { route: 'board', icon: LayoutDashboard, label: ROUTE_LABELS.board, Page: BoardPage },
  // 改动验收已并入工作台（页内视图）。保留 review 路由作为深链别名，
  // 让 #/review、手机「更多」和聊天右栏的「打开验收」继续可用。
  { route: 'review', icon: GitCompare, label: ROUTE_LABELS.review, Page: BoardReviewPage },
  { route: 'lingxi', icon: Sparkles, label: ROUTE_LABELS.lingxi, Page: LingXiPage },
  { route: 'workshop', icon: Factory, label: ROUTE_LABELS.workshop, Page: WorkshopPage },
  // 连续创作已并入创作（页内视图）。保留 story 路由作为深链别名，
  // 让 #/story 与既有收藏继续可用。
  { route: 'story', icon: Sparkles, label: ROUTE_LABELS.story, Page: WorkshopStoryPage },
  { route: 'models', icon: BrainCircuit, label: ROUTE_LABELS.models, Page: ModelHub, nav: false },
  { route: 'assets', icon: Images, label: ROUTE_LABELS.assets, Page: Assets },
  { route: 'tasks', icon: Clock4, label: ROUTE_LABELS.tasks, Page: Tasks },
  { route: 'downloads', icon: Download, label: ROUTE_LABELS.downloads, Page: Downloads },
  { route: 'apps', icon: LayoutGrid, label: ROUTE_LABELS.apps, Page: Apps },
  { route: 'engine', icon: Cpu, label: ROUTE_LABELS.engine, Page: EnginePage },
  { route: 'themes', icon: Palette, label: ROUTE_LABELS.themes, Page: ThemesPage, nav: false },
  { route: 'sessiondb', icon: Database, label: ROUTE_LABELS.sessiondb, Page: SessionDbPage },
  { route: 'system', icon: MonitorCog, label: ROUTE_LABELS.system, Page: SystemPage },
]
const APP_ROUTES: Route[] = ['chat', ...PAGE_ROUTES.map(p => p.route)]
const PAGE_BY_ROUTE = Object.fromEntries(PAGE_ROUTES.map(p => [p.route, p])) as Record<string, PageRoute>
const railItem = (route: (typeof RAIL_PRIMARY)[number] | (typeof RAIL_MORE)[number]) => {
  if (route === 'chat') return { route: 'chat' as Route, icon: MessagesSquare, label: ROUTE_LABELS.chat }
  const page = PAGE_BY_ROUTE[route]
  return { route: route as Route, icon: page.icon, label: page.label }
}

function PageLoader() {
  // 路由懒加载的兜底（2026-09-16 视觉整理）：以前是一行居中的「加载中…」。
  // 文字闪一下不如用灰块把"这一页正在成型"先画出来——它发生在**任何**页面，
  // 包括连续创作（那条路径下用户最容易以为"我的故事没了"）。
  return (
    <div className="flex-1 min-w-0 p-6 space-y-4" role="status" aria-label="加载中">
      <div className="h-6 w-40 rounded-pi-sm bg-pi-bg2 animate-pulse" />
      <div className="h-24 rounded-pi-md bg-pi-bg2 animate-pulse" />
      <div className="grid grid-cols-2 gap-4">
        <div className="h-16 rounded-pi-md bg-pi-bg2 animate-pulse" />
        <div className="h-16 rounded-pi-md bg-pi-bg2 animate-pulse" />
      </div>
      <div className="h-4 w-1/2 rounded-pi-sm bg-pi-bg2 animate-pulse" />
    </div>
  )
}

// 元枢壳框架：顶部自绘标题栏（浏览器里渲染为 null 不占位）+ 内容区占满剩余高度
function ShellFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] h-full flex flex-col relative overflow-hidden">
      <TitleBar />
      <div className="flex-1 flex min-h-0">{children}</div>
    </div>
  )
}

function PageBody({ route }: { route: Route }) {
  const page = PAGE_ROUTES.find(p => p.route === route)
  if (page) {
    const Page = page.Page
    return <Page />
  }
  return null
}

export default function AppLayout() {
  const { authed, logout, selectSession } = useApp()
  const themeReady = useThemePreferences(authed)
  // 首启向导（M1）：登录后零密钥 → 引导初始化；?setup=1 强制唤出
  const [needsSetup, setNeedsSetup] = useState(false)
  useEffect(() => {
    if (!authed) return
    try { if (new URLSearchParams(location.search).get('setup') === '1') { setNeedsSetup(true); return } } catch {}
    KeysApi.status().then((s: any) => { if (s && Array.isArray(s.pi) && s.pi.length === 0) setNeedsSetup(true) }).catch(() => {})
  }, [authed])
  const isMobile = useIsMobile()
  const [route, nav] = useHashRoute(APP_ROUTES)
  // 桌面会话栏折叠（08-26）：持久化到 localStorage
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('pi_sidebar_collapsed') === '1' } catch { return false }
  })
  const toggleSidebar = () => setSidebarCollapsed(v => {
    try { localStorage.setItem('pi_sidebar_collapsed', v ? '0' : '1') } catch {}
    return !v
  })
  const [rightPanel, setRightPanel] = useState<'chat' | UtilityPanelKey>(() => {
    try {
      const saved = localStorage.getItem('pi_right_panel')
      if (saved && ['inspect', 'workspace', 'deliveries', 'terminal', 'activity', 'tui'].includes(saved)) return saved as UtilityPanelKey
    } catch {}
    return 'chat'
  })
  const [panelExpanded, setPanelExpanded] = useState(false)
  const [compactDesktop, setCompactDesktop] = useState(() => window.matchMedia('(max-width: 1320px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 1320px)')
    const update = () => setCompactDesktop(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  const sidebarAutoHidden = compactDesktop && rightPanel !== 'chat'
  const [modelOpen, setModelOpen] = useState(false)
  // 移动端：sessions 抽屉与统一“更多”菜单
  const [mobileDrawer, setMobileDrawer] = useState<'none' | 'sessions'>('none')
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null)
  const closeMobileMore = useCallback(() => {
    setMobileMoreOpen(false)
    requestAnimationFrame(() => mobileMoreTriggerRef.current?.focus())
  }, [])
  // ⌘K 命令面板（08-25 评审 P1：全局快捷键）
  const [paletteOpen, setPaletteOpen] = useState(false)

  useEffect(() => installVisualViewportHeight(), [])

  useEffect(() => {
    try { localStorage.setItem('pi_right_panel', rightPanel) } catch {}
  }, [rightPanel])

  // Theme hydration runs before either shell mounts its wallpaper element.
  useEffect(() => {
    const apply = () => applyWallpaper(currentWallpaper())
    apply()
    window.addEventListener('pi-wallpaper-changed', apply)
    const t = setTimeout(apply, 300)
    return () => { window.removeEventListener('pi-wallpaper-changed', apply); clearTimeout(t) }
  }, [themeReady, isMobile, needsSetup])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    // 欢迎页快捷入口 → 面板联动
    const onOpenPalette = () => setPaletteOpen(true)
    const onOpenPanel = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail === 'terminal' || detail === 'workspace' || detail === 'deliveries') {
        nav('chat'); setRightPanel(detail)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pi-open-palette', onOpenPalette)
    window.addEventListener('pi-open-panel', onOpenPanel)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pi-open-palette', onOpenPalette)
      window.removeEventListener('pi-open-panel', onOpenPanel)
    }
  }, [nav])
  const palette = (
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={nav}
      onRightPanel={p => setRightPanel(p)} onModelManager={() => setModelOpen(true)} />
  )
  const panelContents = (
    <Suspense fallback={<PageLoader />}>
      {rightPanel === 'inspect' ? <TaskInspector
        onOpenSession={sessionId => { selectSession(sessionId); nav('chat') }}
        onOpenReview={() => { setPanelExpanded(false); setRightPanel('chat'); nav('review') }}
      />
        : rightPanel === 'workspace' ? <WorkSpace />
        : rightPanel === 'deliveries' ? <Deliveries />
          : rightPanel === 'activity' ? <ActivityFeed />
            : rightPanel === 'tui' ? <div className="flex-1 min-h-0 flex flex-col"><TuiTerminal /></div>
              : <TerminalPanel />}
    </Suspense>
  )

  if (!authed) return <ShellFrame><Login /></ShellFrame>
  if (!themeReady) return <ShellFrame><div className="flex-1 flex items-center justify-center bg-pi-bg text-pi-dim text-sm" role="status">正在加载工作区...</div></ShellFrame>
  if (needsSetup) return <ShellFrame><SetupWizard onDone={() => setNeedsSetup(false)} /></ShellFrame>

  /* ── 页面容器（非 chat 路由共用）── */
  // min-w-0：flex 子项默认 min-width:auto，内部宽表格会把整页撑出横向滚动（M3 手机审计修复）
  const pageArea = (route !== 'chat') && (
    <div key={route} className="flex-1 flex flex-col min-h-0 min-w-0 overflow-x-hidden page-enter">
      <Suspense fallback={<PageLoader />}>
        <PageErrorBoundary page={PAGE_BY_ROUTE[route]?.label || route}>
          <PageBody route={route} />
        </PageErrorBoundary>
      </Suspense>
    </div>
  )

  /* ── 移动端布局：TabBar 五入口（对话/会话/资产/任务/设置；模型在对话页下拉） ── */
  if (isMobile) {
    return (
      <div className={`mobile-app-root mobile-safe-top flex flex-col text-pi-text relative ${route === 'chat' ? 'mobile-chat-root' : ''}`}>
        <div id="pi-wallpaper" className="fixed inset-0 z-0 pointer-events-none" />
        {/* 删除装饰性径向渐变背景 */}
        {/* 主内容层 */}
        <div className="flex-1 flex min-h-0 relative z-10">
          {mobileDrawer === 'sessions' ? (
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <Sidebar onNavigated={() => { setMobileDrawer('none'); nav('chat') }} onCollapse={() => setMobileDrawer('none')} />
            </div>
          ) : route === 'chat' ? (
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              <PageErrorBoundary page="对话">
                <ChatArea compactHeader />
              </PageErrorBoundary>
              {rightPanel !== 'chat' && (
                <UtilityPanel
                  active={rightPanel}
                  onChange={setRightPanel}
                  onClose={() => { setPanelExpanded(false); setRightPanel('chat') }}
                  expanded={panelExpanded}
                  onToggleExpanded={() => setPanelExpanded(value => !value)}
                  onOpenReview={() => { setPanelExpanded(false); setRightPanel('chat'); nav('review') }}
                >
                  {panelContents}
                </UtilityPanel>
              )}
            </div>
          ) : pageArea}
        </div>

        {/* 底部 TabBar：实底，不用玻璃 */}
        <nav className="mobile-tab-bar flex flex-shrink-0 relative z-20 border-t border-pi-border bg-pi-bg1" aria-label="主要导航">
          {([
            { key: 'chat', icon: MessagesSquare, label: '对话', active: !mobileMoreOpen && route === 'chat' && mobileDrawer === 'none', onClick: () => { setMobileMoreOpen(false); setMobileDrawer('none'); nav('chat') } },
            { key: 'sessions', icon: FolderClosed, label: '会话', active: !mobileMoreOpen && mobileDrawer === 'sessions', onClick: () => { setMobileMoreOpen(false); setMobileDrawer('sessions') } },
            { key: 'assets', icon: Images, label: '资产', active: !mobileMoreOpen && route === 'assets' && mobileDrawer === 'none', onClick: () => { setMobileMoreOpen(false); setMobileDrawer('none'); nav('assets') } },
            { key: 'tasks', icon: Clock4, label: '任务', active: !mobileMoreOpen && route === 'tasks' && mobileDrawer === 'none', onClick: () => { setMobileMoreOpen(false); setMobileDrawer('none'); nav('tasks') } },
            { key: 'more', icon: Ellipsis, label: '更多', active: mobileMoreOpen || (mobileDrawer === 'none' && !['chat', 'assets', 'tasks'].includes(route)), onClick: () => { setMobileDrawer('none'); setMobileMoreOpen(open => !open) } },
          ] as const).map(item => (
            <button
              key={item.key}
              ref={item.key === 'more' ? mobileMoreTriggerRef : undefined}
              aria-label={item.label}
              aria-current={item.active ? 'page' : undefined}
              aria-expanded={item.key === 'more' ? mobileMoreOpen : undefined}
              className={`mobile-tab-button flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${item.active ? 'text-pi-accent' : 'text-pi-dim2'}`}
              onClick={item.onClick}
            >
              <item.icon className="w-[18px] h-[18px]" strokeWidth={1.8} />
              <span className="text-[11px] leading-none">{item.label}</span>
            </button>
          ))}
        </nav>

        <MobileMoreMenu
          open={mobileMoreOpen}
          onClose={closeMobileMore}
          route={route}
          nav={(nextRoute) => { setMobileDrawer('none'); nav(nextRoute) }}
          onOpenPanel={(panel) => { setMobileDrawer('none'); nav('chat'); setRightPanel(panel) }}
          onOpenTheme={() => { setMobileDrawer('none'); nav('themes') }}
          onLogout={logout}
        />

        {modelOpen && <LazyModelManager visible onClose={() => setModelOpen(false)} />}
        {palette}
      </div>
    )
  }

  /* ── 桌面布局：图标 rail + 会话列表 + 主区 + 动态右栏 ── */
  return (
    <ShellFrame>
    <div className={`flex-1 flex min-w-0 text-pi-text relative ${rightPanel !== 'chat' ? 'has-utility-panel' : ''}`}>
      <div id="pi-wallpaper" className="fixed inset-0 z-0 pointer-events-none" />
      {/* 图标导航 rail：实底 Logo，不用渐变 */}
      <nav className="desktop-rail flex-shrink-0 flex flex-col items-center py-4 px-2 gap-1.5 col-sidebar border-r border-pi-border relative z-20" aria-label="主导航">
        <div className="desktop-brand"><img src="/static/branding/yuanshu-app-icon.png?v=desk" alt="" width="28" height="28" /><span>元枢</span></div>
        {(sidebarCollapsed || sidebarAutoHidden) && (
          <button className="w-9 h-9 rounded-pi-md flex items-center justify-center text-pi-dim2 hover:text-pi-text hover:bg-pi-bg3 transition-colors"
            aria-label="展开会话栏" title="展开会话栏" onClick={() => { if (sidebarAutoHidden) setRightPanel('chat'); if (sidebarCollapsed) toggleSidebar() }}>
            <PanelLeftOpen className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </button>
        )}
        {RAIL_PRIMARY.map(railItem).map(n => (
          <T.Root key={n.route}>
            <T.Trigger asChild>
              <button aria-label={n.label} aria-current={route === n.route ? 'page' : undefined} title={n.label}
                className={`desktop-rail-item rounded-pi-md flex items-center gap-2 relative transition-[background-color,color,border-color,box-shadow,transform] duration-200 ${
                  route === n.route ? 'bg-pi-accent text-pi-on-accent shadow-md shadow-pi-accent/25' : 'text-pi-dim hover:text-pi-text hover:bg-pi-bg3'}`}
                onClick={() => nav(n.route)}>
                <n.icon className="w-[18px] h-[18px]" strokeWidth={1.8} />
                <span className="desktop-rail-label">{n.label}</span>
              </button>
            </T.Trigger>
            <T.Portal>
              <T.Content side="right" sideOffset={8}
                className="px-2 py-1 rounded-pi-sm bg-pi-bg3 border border-pi-border text-[11px] text-pi-text whitespace-nowrap shadow-lg z-50" style={{ animationDuration: '.12s' }}>
                {n.label}
              </T.Content>
            </T.Portal>
          </T.Root>
        ))}
        <DesktopMoreMenu items={RAIL_MORE.map(railItem)} route={route} nav={nav} />
        <div className="mt-auto mb-2 flex flex-col gap-1.5">
          <ThemeSwitcher />
          <button className="w-9 h-9 rounded-pi-md flex items-center justify-center text-pi-dim2 hover:text-pi-text hover:bg-pi-bg3 transition-colors" title="模型与通道" aria-label="模型与通道" onClick={() => nav('models')}><Settings2 className="w-[18px] h-[18px]" strokeWidth={1.8} /></button>
          <button className="w-9 h-9 rounded-pi-md flex items-center justify-center text-pi-dim2 hover:text-pi-red hover:bg-pi-bg3 transition-colors" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut className="w-[18px] h-[18px]" strokeWidth={1.8} /></button>
        </div>
      </nav>

      {/* 会话列表：仅对话路由显示 */}
      {route === 'chat' && !sidebarCollapsed && !sidebarAutoHidden && <Sidebar onCollapse={toggleSidebar} />}

      <div className={`flex-1 flex flex-col min-w-0 min-h-0 relative z-10 col-canvas ${route === 'chat' ? 'chat-canvas' : ''}`}>
        {route === 'chat' ? (
          <PageErrorBoundary page="对话">
            <ChatArea rightPanel={rightPanel} onRightPanel={setRightPanel} />
          </PageErrorBoundary>
        ) : pageArea}
      </div>

      {/* 默认是真右栏；仅终端与 TUI 可由用户显式展开。 */}
      {route === 'chat' && rightPanel !== 'chat' && (
        <UtilityPanel
          active={rightPanel}
          onChange={setRightPanel}
          onClose={() => { setPanelExpanded(false); setRightPanel('chat') }}
          expanded={panelExpanded}
          onToggleExpanded={() => setPanelExpanded(value => !value)}
          onOpenReview={() => { setPanelExpanded(false); setRightPanel('chat'); nav('review') }}
        >
          {panelContents}
        </UtilityPanel>
      )}

      {/* 右栏开关已入 ChatArea 顶栏（与状态胶囊并排，不再悬浮遮挡） */}

      {modelOpen && <LazyModelManager visible onClose={() => setModelOpen(false)} />}
      {palette}
    </div>
    </ShellFrame>
  )
}
