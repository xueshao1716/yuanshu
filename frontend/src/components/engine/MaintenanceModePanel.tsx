import { useState } from 'react'
import useSWR from 'swr'
import { MaintenanceApi, ConfirmApi } from '../../api'

export default function MaintenanceModePanel({ sessionId }: { sessionId: string }) {
  const { data, error, mutate } = useSWR(['maintenance-status', sessionId], () => MaintenanceApi.status(sessionId), { keepPreviousData: false, dedupingInterval: 1000, refreshInterval: 2000 })
  const [answering, setAnswering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [pending, setPending] = useState(false)
  const [taskId, setTaskId] = useState(sessionId)
  const [runId, setRunId] = useState(sessionId)
  const invalid = data && (data.sessionId !== sessionId || !Number.isFinite(data.defaultDurationMs) || !Number.isFinite(data.maxDurationMs))
  const request = async () => {
    const tid = taskId.trim() || sessionId
    const rid = runId.trim() || tid
    setBusy(true); setPending(true); setMsg('正在提交授权请求。确认卡会出现在本面板下方，60 秒未确认自动拒绝，不会授予权限。')
    try { await MaintenanceApi.request({ sessionId, taskId: tid, runId: rid, durationMs: data?.defaultDurationMs || 3600000 }); setMsg('超维授权已生效，本次会话会在到期后自动收紧。'); await mutate() }
    catch (e: any) { setMsg(e?.message || '本机未批准或授权请求失败。') }
    finally { setBusy(false); setPending(false) }
  }
  const answer = async (id: string, ok: boolean) => {
    setAnswering(true)
    try {
      const result = await ConfirmApi.answer(sessionId, id, ok)
      if (!result.ok) throw new Error('请求已过期或已在其他页面处理，请刷新状态。')
      setMsg(ok ? '确认已提交，正在核实授权状态…' : '已拒绝本次授权。')
      await mutate()
    } catch (e: any) { setMsg(e?.message || '确认失败，请重试。') }
    finally { setAnswering(false) }
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
    {msg && <div role="status" className="text-sm text-pi-dim mb-2 rounded-pi-md border border-pi-border-soft bg-pi-bg2/50 px-3 py-2">
      <p>{msg}</p>
      {pending && <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
        <button type="button" className="underline" onClick={() => void mutate().catch(() => {})}>刷新授权状态</button>
      </div>}
    </div>}
    {!error && !invalid && data?.pending?.map(item => <div key={item.id} role="group" aria-label="超维授权确认" className="mb-3 rounded-pi-md border border-pi-warning p-3 text-[12px] space-y-2 break-words">
      <p className="font-semibold">{item.reason} · 待人工确认</p>
      <p>任务：{item.taskId} · 运行：{item.runId}</p>
      <p>有效至 {new Date(item.expiresAt).toLocaleTimeString()}；过期未确认不授权。</p>
      {data.canConfirm ? <button type="button" disabled={answering} className="min-h-11 px-3 border rounded-pi-md" onClick={() => void answer(item.id, true)}>批准本次超维授权</button> : <p>请在运行元枢的电脑打开 http://127.0.0.1:8787/#/engine，选择同一会话，在此面板批准。手机及远程域名不能批准。</p>}
      <button type="button" disabled={answering} className="min-h-11 px-3 underline" onClick={() => void answer(item.id, false)}>取消这次请求</button>
    </div>)}
    {data?.lease && <p role="status" className="text-[12px] mb-3">授权已生效，至 {new Date(data.lease.expiresAt).toLocaleString()} 自动到期。</p>}
    <p className="text-sm text-pi-dim leading-relaxed mb-3">权限绑定会话、任务和单次运行；到期停止接受新动作，不能自行续期。批准必须从运行元枢电脑的本地地址提交，远程页面只能请求或取消。</p>
    <p className="text-sm text-pi-dim leading-relaxed mb-3">覆盖目标为元枢执行器，不覆盖 Pi SDK。原有沙箱档位不会因此放宽。</p>
    {data?.available ? data.lease ? <button type="button" disabled={busy} onClick={() => void revoke()} className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-warning text-sm text-pi-text disabled:opacity-60">撤销当前超维授权</button> : <button type="button" disabled={busy} onClick={() => void request()} className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-accent text-sm text-pi-text disabled:opacity-60">{busy ? '已提交，等待电脑确认…' : '请求本机确认并启用'}</button> : <button type="button" disabled className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-border-soft text-sm text-pi-dim cursor-not-allowed">不可启用 · 执行器待接入</button>}
  </section>
}
