import { useEffect, useMemo, useRef, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { useRestoreFocus } from '../hooks/useRestoreFocus'
import { MessagesSquare, BrainCircuit, ClipboardCheck, Images, Clock4, LayoutGrid, FolderClosed, Package, SquareTerminal, Settings2, Plus, CornerDownLeft, LayoutDashboard, Sparkles, Factory, Palette, Database, MonitorCog, Cpu, Activity, ChevronsLeftRight, ShieldCheck, Workflow } from 'lucide-react'
import { useApp } from '../store'
import { toast } from './Toast'
import { SessionsApi } from '../api'
import type { Route } from '../hooks/useHashRoute'
import type { UtilityPanelKey } from './MobileMoreMenu'

// ── ⌘K 命令面板（08-25 评审 P1：power-user 工作台零快捷键的补课）──
// 全局 Ctrl/Cmd+K 唤起；页面跳转 / 新建会话 / 右栏切换 / 会话搜索直达

interface PaletteProps {
  open: boolean
  onClose: () => void
  nav: (r: Route) => void
  onRightPanel: (p: UtilityPanelKey) => void
  onModelManager: () => void
}

interface Item {
  key: string
  icon: typeof MessagesSquare
  label: string
  hint?: string
  keywords?: string
  run: () => void
}

export default function CommandPalette({ open, onClose, nav, onRightPanel, onModelManager }: PaletteProps) {
  const { sessions, selectSession, refreshSessions } = useApp()
  const [query, setQuery] = useState('')
  const [hi, setHi] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useRestoreFocus(open)

  // 打开时重置状态并聚焦
  useEffect(() => {
    if (open) { setQuery(''); setHi(0); setTimeout(() => inputRef.current?.focus(), 0) }
  }, [open])

  const items: Item[] = useMemo(() => {
    const page = (r: Route, label: string, Icon: typeof MessagesSquare): Item =>
      ({ key: 'page-' + r, icon: Icon, label, hint: '页面', run: () => { nav(r); onClose() } })
    const base: Item[] = [
      { key: 'new', icon: Plus, label: '新建会话', hint: '动作', run: async () => { try { const d = await SessionsApi.create(); await refreshSessions(); selectSession(d.id); nav('chat') } catch { toast('新建会话失败，请重试', 'error') } onClose() } },
      page('chat', '打开对话', MessagesSquare),
      page('board', '打开工作台', LayoutDashboard),
      page('lingxi', '打开灵感', Sparkles),
      page('workshop', '打开创作', Factory),
      page('canvas', '打开无限画布', Workflow),
      page('models', '打开模型', BrainCircuit),
      page('assets', '打开资产', Images),
      page('tasks', '打开任务', Clock4),
      page('apps', '打开知识', LayoutGrid),
      page('engine', '打开能力', Cpu),
      page('themes', '打开主题', Palette),
      page('sessiondb', '打开会话库', Database),
      page('system', '打开系统', MonitorCog),
      page('grants', '打开授权中心（放权 / 提权 / 批准）', ShieldCheck),
      { key: 'rp-inspect', icon: ClipboardCheck, label: '右栏 · 任务检查', hint: '对话页', run: () => { onRightPanel('inspect'); nav('chat'); onClose() } },
      { key: 'rp-workspace', icon: FolderClosed, label: '右栏 · 工作空间', hint: '对话页', run: () => { onRightPanel('workspace'); nav('chat'); onClose() } },
      { key: 'rp-deliveries', icon: Package, label: '右栏 · 交付物', hint: '对话页', run: () => { onRightPanel('deliveries'); nav('chat'); onClose() } },
      { key: 'rp-terminal', icon: SquareTerminal, label: '右栏 · 终端', hint: '对话页', run: () => { onRightPanel('terminal'); nav('chat'); onClose() } },
      { key: 'rp-activity', icon: Activity, label: '右栏 · 活动', hint: '对话页', run: () => { onRightPanel('activity'); nav('chat'); onClose() } },
      { key: 'rp-tui', icon: ChevronsLeftRight, label: '右栏 · TUI', hint: '对话页', run: () => { onRightPanel('tui'); nav('chat'); onClose() } },
      { key: 'mm', icon: Settings2, label: '密钥与通道管理', hint: '面板', run: () => { onModelManager(); onClose() } },
    ]
    // 会话直达（按关键词过滤后追加在后面）
    for (const s of sessions.slice(0, 30)) {
      base.push({
        key: 's-' + s.id, icon: MessagesSquare,
        label: s.name || '新会话', hint: '会话',
        keywords: s.preview || '',
        run: () => { selectSession(s.id); nav('chat'); onClose() },
      })
    }
    return base
  }, [sessions, nav, onClose, onRightPanel, onModelManager, refreshSessions, selectSession])

  const kw = query.trim().toLowerCase()
  const filtered = useMemo(() => (kw
    ? items.filter(i => i.label.toLowerCase().includes(kw) || (i.keywords || '').toLowerCase().includes(kw))
            : items).slice(0, 20), [items, kw])

  useEffect(() => { if (hi >= filtered.length) setHi(0) }, [filtered.length]) // eslint-disable-line

  // 高亮项滚入视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [hi])

  // 注意：不能用 early-return null 卸载整棵树——Radix 关闭时需要在位归还焦点，
  // 由 D.Root 的受控 open 自行决定是否渲染（08-25 冒烟实测：early-return 导致焦点掉 body）

  const runItem = (i: Item) => i.run()

  // Radix Dialog 提供焦点陷阱 + 关闭后焦点归还 + Esc/外点关闭；外观仍是液态玻璃
  return (
    <D.Root open={open} onOpenChange={o => { if (!o) onClose() }}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[var(--pi-z-palette)] bg-black/60" />
        <D.Content aria-label="命令面板"
          onOpenAutoFocus={e => { e.preventDefault(); setTimeout(() => inputRef.current?.focus(), 0) }}
          className="fixed left-1/2 top-[12vh] -translate-x-1/2 z-[var(--pi-z-palette-content)] w-full max-w-lg px-4 sm:px-0">
          <div className="rounded-pi-xl glass-strong glass-hi overflow-hidden" style={{ animationDuration: '.18s' }}>
            <input
              data-slot="command-input"
              ref={inputRef}
              className="w-full bg-transparent border-none outline-none px-4 py-3.5 text-[15px] text-pi-text placeholder:text-pi-dim2 border-b border-pi-border-soft"
              placeholder="搜索命令、页面、会话…"
              value={query}
              onChange={e => { setQuery(e.target.value); setHi(0) }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, filtered.length - 1)) }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)) }
                else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[hi]; if (it) runItem(it) }
              }}
              aria-label="搜索命令"
              aria-activedescendant={filtered[hi] ? 'cmd-' + filtered[hi].key : undefined}
            />
            <div ref={listRef} data-slot="command-list" className="max-h-80 overflow-y-auto p-1.5" role="listbox">
              {filtered.length === 0 && <div className="px-3 py-6 text-center text-pi-dim2 text-xs">没有匹配项</div>}
              {filtered.map((it, idx) => (
                <button
                  key={it.key} id={'cmd-' + it.key} data-idx={idx}
                  role="option" aria-selected={idx === hi}
                  tabIndex={-1}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-pi-md text-left transition-colors ${idx === hi ? 'bg-pi-accent/15 text-pi-text' : 'text-pi-dim hover:bg-pi-bg-hover'}`}
                  onMouseEnter={() => setHi(idx)}
                  onClick={() => runItem(it)}
                >
                  <it.icon className={`w-4 h-4 flex-shrink-0 ${idx === hi ? 'text-pi-accent' : ''}`} strokeWidth={1.8} />
                  <span className="flex-1 min-w-0 truncate text-[13px]">{it.label}</span>
                  {it.hint && <span className="text-[10px] text-pi-dim2 flex-shrink-0">{it.hint}</span>}
                  {idx === hi && <CornerDownLeft className="w-3 h-3 text-pi-dim2 flex-shrink-0" />}
                </button>
              ))}
            </div>
            <div className="px-4 py-2 border-t border-pi-border-soft text-[11px] text-pi-dim2 flex items-center gap-3">
              <span>↑↓ 选择</span><span>Enter 执行</span><span>Esc 关闭</span>
              <span className="ml-auto">Ctrl / ⌘ + K 随时唤起</span>
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
