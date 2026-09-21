// ── 待审改动（2026-09-20）──────────────────────────────────────────────
// 由来：openwriter（MIT）的核心是"agent 写字、人审阅"——改动先以 diff 到达，接受/拒绝一次按键。
// 这里落在工作台「改动验收」里：待审列表 + diff 预览 + 接受/拒绝（接受才真正写盘，后端留审计）。
import { useRef, useState } from 'react'
import useSWR from 'swr'
import { api } from '../api'

const getJson = (u: string) => api(u)

export function PendingChanges() {
  const { data, error, mutate, isLoading } = useSWR('pending-changes', () => getJson('/api/pending'), { refreshInterval: 15_000 })
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [actionError, setActionError] = useState('')
  const items: any[] = data?.items || []

  const act = async (id: string, kind: 'accept' | 'reject') => {
    if (locked.current) return
    locked.current = true; setBusy(true); setActionError('')
    try {
      await api(`/api/pending/${encodeURIComponent(id)}/${kind}`, { method: 'POST', body: { reason: kind === 'reject' ? '工作台拒绝' : undefined } })
    } catch (e) { setActionError(e instanceof Error ? e.message : '操作失败，请重试') }
    finally { await mutate().catch(() => {}); locked.current = false; setBusy(false) }
  }
  const [open, setOpen] = useState<string | null>(null)

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-pi-text">待审改动</span>
        <span className="text-[11px] text-pi-dim">{isLoading ? '读取中…' : `${items.length} 条待你定`}</span>
        <span className="ml-auto text-[10px] text-pi-dim">接受才写盘（有备份 + 审计）</span>
      </div>
      {(error || actionError) && <div role="alert" className="text-[12px] text-pi-text">{actionError || `读取失败：${error.message}`}</div>}
      {!isLoading && !error && !items.length && <div className="text-[11px] text-pi-dim">没有待审改动。通过待审接口提交的提议会落到这里；其他文件操作不代表已进入验收流程。</div>}
      {items.map((it) => (
        <div key={it.id} className="rounded-pi-md bg-pi-bg3 p-2 flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-pi-text break-all">{it.target}</span>
            <span className="text-[10px] text-pi-dim">by {it.by} · {String(it.at || '').slice(11, 19)}</span>
            <span className="text-[10px] text-pi-accent">+{it.added ?? '?'} / -{it.removed ?? '?'}</span>
            <div className="ml-auto flex gap-1">
              <button type="button" disabled={busy || it.status !== 'pending'} onClick={() => act(it.id, 'accept')} className="min-h-11 disabled:opacity-50 text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-accent text-pi-on-accent">接受</button>
              <button type="button" disabled={busy || it.status !== 'pending'} onClick={() => act(it.id, 'reject')} className="min-h-11 disabled:opacity-50 text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg2 text-pi-text">拒绝</button>
              <button type="button" onClick={() => setOpen(open === it.id ? null : it.id)} className="min-h-11 text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg2 text-pi-dim">{open === it.id ? '收起' : '看 diff'}</button>
            </div>
          </div>
          {it.note && <div className="text-[10px] text-pi-dim">{it.note}</div>}
          {it.status !== 'pending' && <div role="alert" className="text-[11px] text-pi-text">待恢复：文件可能已写入，但验收记录未完成。请核对文件、备份和审计记录，不要重复接受。</div>}
          {open === it.id && <DiffView id={it.id} />}
        </div>
      ))}
    </div>
  )
}

function DiffView({ id }: { id: string }) {
  const { data, error, isLoading } = useSWR(['pending-diff', id], () => getJson(`/api/pending/${encodeURIComponent(id)}`))
  if (error) return <div role="alert">差异读取失败：{error.message}</div>
  if (isLoading) return <div role="status">正在读取差异…</div>
  const text: string = data?.item?.diff?.text || '（无 diff）'
  return (
    <pre className="mt-1 max-h-72 overflow-auto text-[11px] leading-[1.5] whitespace-pre-wrap break-all bg-pi-bg2 rounded-pi-md p-2">
      {text.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+ ') ? 'text-pi-accent' : line.startsWith('- ') ? 'text-red-400' : 'text-pi-dim'}>{line || ' '}</div>
      ))}
    </pre>
  )
}
