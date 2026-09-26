import useSWR from 'swr'
import { MaintenanceApi } from '../../api'

export default function MaintenanceModePanel({ sessionId }: { sessionId: string }) {
  const { data, error, mutate } = useSWR(['maintenance-status', sessionId], () => MaintenanceApi.status(sessionId), { keepPreviousData: false, dedupingInterval: 15000 })
  const invalid = data && (data.sessionId !== sessionId || data.available !== false || data.lease !== null || !Number.isFinite(data.defaultDurationMs) || !Number.isFinite(data.maxDurationMs))
  return <section className="border-t border-pi-border-soft py-5" aria-labelledby="maintenance-mode-title">
    <h2 id="maintenance-mode-title" className="text-sm font-semibold text-pi-text mb-2">超维模式 · 授权维护</h2>
    {error || invalid ? <div role="alert" className="text-sm text-pi-warning">
      <p>无法确认维护能力状态，当前不可启用。</p>
      <button type="button" className="min-h-11 underline" onClick={() => void mutate().catch(() => {})}>重新读取维护状态</button>
    </div> : !data ? <p role="status" className="text-sm text-pi-dim">正在检查维护能力…</p> : <>
      <p className="text-sm text-pi-text mb-2">默认授权 {data.defaultDurationMs / 3600000} 小时，单次最长 {data.maxDurationMs / 3600000} 小时。</p>
      <p role="status" className="text-sm text-pi-dim leading-relaxed mb-3">{data.message}</p>
    </>}
    <p className="text-sm text-pi-dim leading-relaxed mb-3">权限将绑定会话、任务和单次运行；到期停止接受新动作，不能自行续期。仅本机可信人工批准后生效，浏览器与手机不能直接授予权限。</p>
    <p className="text-sm text-pi-dim leading-relaxed mb-3">覆盖目标为元枢执行器，不覆盖 Pi SDK。原有沙箱档位不会因此放宽。</p>
    <button type="button" disabled className="min-h-11 px-3 py-2 rounded-pi-md border border-pi-border-soft text-sm text-pi-dim cursor-not-allowed">不可启用 · 执行器待接入</button>
  </section>
}
