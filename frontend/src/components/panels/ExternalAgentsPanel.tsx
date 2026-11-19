// ══════════════════════════════════════════════════════════
// ExternalAgentsPanel —— 设置页「外部智能体」开关（2026-11-19）
// 元枢的 delegate_external 能把编码活派给本机的命令行智能体（Claude Code / Codex / 通义 Qwen Code 等）。
// 总开关 + 每天次数 + 每个智能体单独勾选；没装的显示安装命令。
// ══════════════════════════════════════════════════════════
import { useEffect, useState } from 'react'
import { CheckCircle2, AlertTriangle } from 'lucide-react'
import { SystemApi, type ExternalAgentsStatus } from '../../api'
import { toast } from '../shell/Toast'

export default function ExternalAgentsPanel() {
  const [st, setSt] = useState<ExternalAgentsStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { SystemApi.externalAgents().then(setSt).catch(() => setSt(null)) }, [])

  const save = async (patch: { enabled?: boolean; dailyCap?: number; agents?: Record<string, boolean> }) => {
    setBusy(true)
    try {
      const next = await SystemApi.saveExternalAgents(patch)
      setSt(s => ({ ...next, agents: s?.agents }))
      if (patch.enabled !== undefined) toast(patch.enabled ? '已开启：元枢可以把编码活派给勾选的外部智能体' : '已关闭外部智能体', 'ok')
    } catch (e: any) {
      toast(String(e?.message || e), 'error')
    } finally { setBusy(false) }
  }

  if (!st) return <div className="text-xs text-pi-dim2">读取中…</div>
  const on = st.enabled

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button
          role="switch"
          aria-checked={on}
          aria-label="外部智能体"
          disabled={busy}
          onClick={() => save({ enabled: !on })}
          className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
          style={{ background: on ? 'var(--pi-accent)' : 'var(--pi-border)' }}
        >
          <span
            className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: on ? '22px' : '2px', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }}
          />
        </button>
        <div className="min-w-0">
          <div className="text-[13px] text-pi-text">{on ? '已开启' : '已关闭'}</div>
          <div className="text-[11px] text-pi-dim2">今天已用 {st.usedToday} / {st.dailyCap} 次</div>
        </div>
        <label className="ml-auto flex items-center gap-2 text-[12px] text-pi-dim">
          每天最多
          <input
            type="number" min={0} max={50}
            defaultValue={st.dailyCap}
            disabled={busy}
            onBlur={e => { const n = Number(e.target.value); if (n !== st.dailyCap) save({ dailyCap: n }) }}
            className="w-16 px-2 py-1 rounded bg-pi-bg border border-pi-border text-pi-text text-xs"
          />
          次
        </label>
      </div>
      <div className="space-y-1">
        {Object.entries(st.agents || {}).map(([id, a]) => (
          <div key={id} className="flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              aria-label={`允许派给 ${a.label}`}
              checked={!!st.on?.[id]}
              disabled={busy || (!a.available && !st.on?.[id])}
              onChange={e => save({ agents: { [id]: e.target.checked } })}
            />
            {a.available
              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              : <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
            <span className="text-pi-text">{a.label}</span>
            <span className="text-pi-dim2 truncate" title={a.available ? '' : a.install}>{a.available ? a.version : `${a.reason}${a.install ? `（安装：${a.install}）` : ''}`}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
