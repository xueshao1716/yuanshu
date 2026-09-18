import { useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import * as AL from '@radix-ui/react-alert-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useApp } from '../store'
import { SessionsApi } from '../api'
import type { Session } from '../types'
import { useRestoreFocus } from '../hooks/useRestoreFocus'
import { ChevronRight, Ellipsis, MessageSquare, PanelLeftClose, PencilLine, Plus, Trash2 } from 'lucide-react'

const GROUP_LABEL: Record<string, string> = {
  workspace: '工作会话',
  test: '小语真测',
  terminal: '小语终端',
}
// 分组排序：工作会话 → 小语真测 → 小语终端
const GROUP_ORDER = ['workspace', 'test', 'terminal']

// 分组折叠状态持久化（记住用户偏好）
function loadCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('pi_groups_collapsed') || '[]')) } catch { return new Set() }
}

export default function Sidebar({ onNavigated, onCollapse }: { onNavigated?: () => void; onCollapse?: () => void } = {}) {
  const { sessions, currentSessionId, selectSession, refreshSessions } = useApp()
  const [renaming, setRenaming] = useState<{ sid: string; name: string } | null>(null)
  const [confirming, setConfirming] = useState<Session | null>(null)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  // Radix Dialog 关闭不归还焦点（1.x 行为），自补
  useRestoreFocus(!!confirming)
  useRestoreFocus(!!renaming)

  const handleNew = async () => {
    // 先切会话、再后台刷新列表：刷新挡在前面会让 currentSessionId 空几秒，
    // 那几秒里上传附件不带 sessionId → 卡片落到别的会话（真机 bug）。
    try { const d = await SessionsApi.create(); selectSession(d.id); onNavigated?.(); void refreshSessions() }
    catch {}
  }
  const handleRename = async () => {
    if (renaming?.name.trim()) { try { await SessionsApi.rename(renaming.sid, renaming.name.trim()); await refreshSessions() } catch {} }
    setRenaming(null)
  }
  const handleDelete = async (s: Session) => {
    try { await SessionsApi.remove(s.id); await refreshSessions() } catch {}
    setConfirming(null)
  }

  const kw = search.trim().toLowerCase()
  const filtered = kw
    ? sessions.filter(s => (s.name || '').toLowerCase().includes(kw) || (s.preview || '').toLowerCase().includes(kw))
    : sessions
  const groups: Record<string, Session[]> = {}
  for (const s of filtered) {
    const g = s.group || 'workspace'
    if (!GROUP_LABEL[g]) continue
    (groups[g] = groups[g] || []).push(s)
  }
  const groupKeys = Object.keys(groups).sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })

  return (
    <aside className="session-sidebar w-full md:w-64 flex-shrink-0 flex flex-col col-sidebar md:border-r border-pi-border/50 min-h-0 h-full relative z-10">
      {/* 品牌头 */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-pi-border-soft/50 flex-shrink-0">
        <img
          className="h-8 w-8 shrink-0 rounded-pi-md"
          src="/static/branding/yuanshu-app-icon.png?v=desk"
          alt="元枢"
        />
        <div className="min-w-0">
          <div className="font-semibold text-[15px] leading-tight">小语</div>
        </div>
        {onCollapse && (
          <button className="ml-auto touch-hit p-1.5 text-pi-dim2 hover:text-pi-text hover:bg-pi-bg3 rounded-pi-sm transition-colors"
            aria-label="收起会话栏" title="收起会话栏" onClick={onCollapse}>
            <PanelLeftClose className="w-4 h-4" strokeWidth={1.8} />
          </button>
        )}
      </div>

      {/* 新建 */}
      <div className="p-3 pb-2 flex-shrink-0">
        <button className="btn-primary w-full min-h-10" onClick={handleNew}>
          <Plus className="w-4 h-4" />
          新建会话
        </button>
        <input
          className="input-pi mt-2 !py-1.5 text-xs"
          placeholder="搜索会话…"
          aria-label="搜索会话"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groupKeys.map(g => groups[g].length > 0 && (
          <div key={g} className="mb-3">
            {/* 分组头：可点击折叠，chevron+计数让归属一眼可辨 */}
            <button
              className="w-full flex items-center gap-1 px-2 py-1.5 rounded-pi-sm hover:bg-pi-bg3 transition-colors duration-fast"
              aria-expanded={!collapsed.has(g)}
              onClick={() => setCollapsed(prev => {
                const n = new Set(prev); n.has(g) ? n.delete(g) : n.add(g)
                try { localStorage.setItem('pi_groups_collapsed', JSON.stringify([...n])) } catch {}
                return n
              })}>
              <ChevronRight className={`w-3 h-3 text-pi-dim2 transition-transform duration-fast ${collapsed.has(g) ? '' : 'rotate-90'}`} />
              <span className="text-[11px] text-pi-dim font-medium">{GROUP_LABEL[g] || g}</span>
              <span className="ml-auto text-[11px] text-pi-dim2">{groups[g].length}</span>
            </button>
            {!collapsed.has(g) && groups[g].map(s => (
              <div key={s.id} className="session-row" data-active={s.id === currentSessionId}>
                <button type="button" className="session-select" aria-current={s.id === currentSessionId ? 'page' : undefined} title={s.name || '新会话'} onClick={() => { selectSession(s.id); onNavigated?.() }}>
                  <MessageSquare className="w-4 h-4 shrink-0 text-pi-dim2" strokeWidth={1.6} />
                  <span className="min-w-0 flex-1"><span className="block text-[13px] truncate text-pi-text">{s.name || '新会话'}</span><span className="block text-[11px] text-pi-dim2 truncate mt-0.5">{s.preview || ''}</span></span>
                </button>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild><button type="button" className="session-menu-trigger" aria-label={`会话操作 ${s.name || '新会话'}`} title="会话操作"><Ellipsis className="w-4 h-4" /></button></DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} collisionPadding={8} className="session-menu" onCloseAutoFocus={event => { if (renaming || confirming) event.preventDefault() }}>
                      <DropdownMenu.Item className="session-menu-item" onSelect={() => setRenaming({ sid: s.id, name: s.name || '' })}><PencilLine className="w-4 h-4" />重命名</DropdownMenu.Item>
                      <DropdownMenu.Item className="session-menu-item text-pi-danger" onSelect={() => setConfirming(s)}><Trash2 className="w-4 h-4" />删除会话</DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            ))}
          </div>
        ))}
        {!groupKeys.length && <p className="px-2 py-8 text-xs text-center text-pi-dim2">{kw ? '没有匹配的会话' : '新建会话，开始工作'}</p>}
      </div>

      {/* 删除确认（Radix AlertDialog：焦点陷阱 + 归还 + Esc 内置）*/}
      <AL.Root open={!!confirming} onOpenChange={o => !o && setConfirming(null)}>
        <AL.Portal>
          <AL.Overlay className="fixed inset-0 bg-black/50 z-[var(--pi-z-dialog)]" />
          <AL.Content data-slot="session-delete-dialog" className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 panel p-4 w-72 z-[var(--pi-z-dialog-top)]" style={{ animationDuration: '.18s' }}>
            <AL.Title className="text-sm font-semibold mb-1.5">删除会话</AL.Title>
            <AL.Description className="text-xs text-pi-dim mb-3">
              「{confirming?.name || '新会话'}」将被永久删除，不可恢复。
            </AL.Description>
            <div className="flex justify-end gap-2">
              <AL.Cancel className="btn-ghost">取消</AL.Cancel>
              <AL.Action className="btn bg-pi-red/90 text-white hover:bg-pi-red" onClick={() => confirming && handleDelete(confirming)}>删除</AL.Action>
            </div>
          </AL.Content>
        </AL.Portal>
      </AL.Root>

      {/* 重命名（Radix Dialog）*/}
      <D.Root open={!!renaming} onOpenChange={o => !o && setRenaming(null)}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 bg-black/50 z-[var(--pi-z-dialog)]" />
          <D.Content data-slot="session-rename-dialog" className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 panel p-4 w-72 z-[var(--pi-z-dialog-top)]" style={{ animationDuration: '.18s' }}>
            <D.Title className="text-sm font-semibold mb-3">重命名会话</D.Title>
            <input className="input-pi mb-3" autoFocus value={renaming?.name || ''} onChange={e => renaming && setRenaming({ ...renaming, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && handleRename()} />
            <div className="flex justify-end gap-2">
              <D.Close className="btn-ghost">取消</D.Close>
              <button className="btn-primary" onClick={handleRename}>确定</button>
            </div>
          </D.Content>
        </D.Portal>
      </D.Root>
    </aside>
  )
}
