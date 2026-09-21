// ── 版本回溯（2026-09-20）──────────────────────────────────────────────
// 敢让 agent 多动手的前提是"随时能退回去"：列出所有 .bak* 备份 + 天团运行快照，一键回滚（回滚前再存一份）。
import useSWR from 'swr'
import { useRef, useState } from 'react'
import { api } from '../api'

const getJson = (u: string) => api(u)

export function HistoryPanel() {
  const { data, error, mutate, isLoading } = useSWR('history-points', () => getJson('/api/history'), { refreshInterval: 60_000 })
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [actionError, setActionError] = useState('')
  const backups: any[] = data?.backups || []
  const runs: any[] = data?.runs || []

  const rollback = async (backup: string) => {
    if (locked.current) return
    if (!confirm('回滚到这个备份？当前内容会先另存一份 .bak-rollback-<时间>\n\n' + backup)) return
    locked.current = true; setBusy(true); setActionError('')
    try {
      await api('/api/history/rollback', { method: 'POST', body: { backup } })
      await mutate()
    } catch (e) { setActionError(e instanceof Error ? e.message : '回滚失败，请重试') }
    finally { locked.current = false; setBusy(false) }
  }

  return (
    <div className="panel p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-pi-text">版本回溯</span>
        <span className="text-[11px] text-pi-dim">{isLoading ? '读取中…' : `${backups.length} 个备份 · ${runs.length} 次运行快照`}</span>
        <span className="ml-auto text-[10px] text-pi-dim">回滚前会先另存当前内容</span>
      </div>
      {(error || actionError) && <div role="alert" className="text-[12px] text-pi-text">{actionError || `读取失败：${error.message}`}</div>}
      {!isLoading && !error && !backups.length && <div className="text-[11px] text-pi-dim">还没有可回滚的备份点。受保护文件不通过此入口恢复。</div>}
      {backups.slice(0, 12).map((b) => (
        <div key={b.backup} className="flex flex-wrap items-center gap-2 rounded-pi-md bg-pi-bg3 p-2">
          <span className="text-[11px] text-pi-text break-all">{b.target}</span>
          <span className="text-[10px] text-pi-dim">{String(b.at || '').slice(0, 16).replace('T', ' ')} · {Math.max(1, Math.round((b.size || 0) / 1024))}KB</span>
          <span className="text-[10px] text-pi-dim break-all">← {String(b.backup).split('\\').pop()}</span>
          <button type="button" disabled={busy} onClick={() => rollback(b.backup)} className="min-h-11 disabled:opacity-50 ml-auto text-[11px] px-2 py-0.5 rounded-pi-pill bg-pi-bg2 text-pi-text">回滚</button>
        </div>
      ))}
      {!!runs.length && (
        <details className="rounded-pi-md bg-pi-bg3 p-2">
          <summary className="text-[11px] text-pi-text cursor-pointer">运行快照（{runs.length}）</summary>
          {runs.slice(0, 8).map((r) => (
            <div key={r.id} className="text-[10px] text-pi-dim mt-1">
              <span className="text-pi-text">{r.id}</span> · {String(r.at || '').slice(0, 16).replace('T', ' ')} · {(r.deliveries || []).join('、') || '（无交付）'}
            </div>
          ))}
        </details>
      )}
    </div>
  )
}
