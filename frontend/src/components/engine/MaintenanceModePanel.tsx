import { useState } from 'react'
import useSWR from 'swr'
import { MaintenanceApi } from '../../api'

export default function MaintenanceModePanel({ sessionId }: { sessionId: string }) {
  const { data, error, mutate } = useSWR(['maintenance-status', sessionId], () => MaintenanceApi.status(sessionId), { keepPreviousData: false, dedupingInterval: 15000 })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [taskId, setTaskId] = useState(sessionId)
  const [runId, setRunId] = useState(sessionId)
  const invalid = data && (data.sessionId !== sessionId || !Number.isFinite(data.defaultDurationMs) || !Number.isFinite(data.maxDurationMs))
  const request = async () => {
    setBusy(true); setMsg('正在等待本机确认…')
    try { await MaintenanceApi.request({ sessionId, taskId: taskId.trim() || sessionId, runId: runId.trim() || taskId.trim() || sessionId, durationMs: data?.defaultDurationMs || 3600000 }); setMsg('超维授权已生效，本次会话会在到期后自动收紧。'); await mutate() }
    catch (e: any) { setMsg(e?.message || '本机未批准或授权请求失败。') }
    finally { setBusy(false) }
  }
  const revoke = async () => { if (!data?.lease?.leaseId) return; setBusy(true); try { await MaintenanceApi.revoke(data.lease.leaseId, sessionId); setMsg('超维授权已撤销。'); await mutate() } catch (e: any) { setMsg(e?.message || '撤销失败。') } finally { setBusy(false) } }
  return <section className="border-t border-pi-border-soft py-5" aria-labelledby="maintenance-mode-title">
    <h2 id="maintenance-mode-title" className="text-sm font-semibold text-pi-text mb-2">超维模式 · 授权维护</h2>
    {error || invalid ? <div role="alert" className="text-sm text-pi-warning">
      <p>无法确认维护能力状态，当前不可启用。</p>
      <button type="button" className="min-h-11 underline" onClick={() => void mutate().catch(() => {})}>重新读取维护状态</button>
    </div> : !data ? <p role="status" className="text-sm text-pi-dim">正在检查维护能力…</p> : <>
      <p className="text-sm text-pi-text mb-2">默认授权 {data.defaultDurationMs / 3600000} 小时，单次最长 {data.maxDurationMs / 3600000} 小时。</p>
      <p role="status" className="text-sm text-pi-dim leading-relaxed mb-3">{data.message}</p>
    </>}
    {data?.available && !data.lease && <div className="grid sm:grid-cols-2 gap-2 mb-3">
      <label className="text-xs text-pi-dim">任务编号<input value={taskId} onChange={e => setTaskId(e.target.value)} className="mt-1 w-full min-h-10 rounded-pi-md border border-pi-border-soft bg-pi-bg px-2 text-sm text-pi-text" /></label>
      <label className="text-xs text-pi-dim">本次运行编号<input value={runId} onChange={e => setRunId(e.target.value)} className="mt-1 w-full min-h-10 rounded-pi-md border border-pi-border-soft bg-pi-bg px-2 text-sm text-pi-text" /></label>
    </div>}
    {msg && <p role="status" className="text-sm text-pi-dim mb-2">{msg}</p>}
    <p className="text-sm text-pi-dim leading-relaxed mb-3">权限将绑定会话、任务和单次运行；到期停止接受新动作，不能自行续期。仅本机可信人工批准后生效，浏览器与手机不能直接授予权限。</p>
    <p className="text-sm text-pi-dim leading-relaxed mb-3">覆盖目标为元枢执行器，不覆盖 Pi SDK。原有沙箱档位不会因此放宽。</p>
    {data?.available ? data.lease ? <button type="button" disabled={busy} onClick={() => void revoke()} className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-warning text-sm text-pi-text disabled:opacity-60">撤销当前超维授权</button> : <button type="button" disabled={busy} onClick={() => void request()} className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-accent text-sm text-pi-text disabled:opacity-60">{busy ? '等待本机确认…' : '请求本机确认并启用'}</button> : <button type="button" disabled className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-border-soft text-sm text-pi-dim cursor-not-allowed">不可启用 · 执行器待接入</button>}
  </section>
}
