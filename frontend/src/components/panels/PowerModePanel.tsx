import ThemedSelect from '../ThemedSelect'
import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { ShieldOff, Zap } from 'lucide-react'
import { AuthorityApi, type FullAuthorityView } from '../../api'
import SectionHeader from '../SectionHeader'

// 全权模式 / 大胆模式（2026-11-24）
// 全权：限时把所有确认卡自动批准，到点自动收回；开启只许电脑本机，收回哪里都行。
// 大胆：只改她的说话做事风格（提示词），不跳过任何确认。

export function remainText(ms: number) {
  const m = Math.max(0, Math.ceil(ms / 60000))
  return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`
}

export function useFullAuthority() {
  return useSWR<FullAuthorityView>('authority-full', AuthorityApi.full, {
    refreshInterval: data => data?.on ? 30000 : 0, revalidateOnFocus: true, shouldRetryOnError: false,
  })
}

export default function PowerModePanel() {
  const full = useFullAuthority()
  const bold = useSWR('authority-bold', AuthorityApi.bold, { shouldRetryOnError: false })
  const [hours, setHours] = useState(1)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  // 倒计时每 30 秒刷一下显示，不必每次都打接口
  useEffect(() => { if (!full.data?.on) return; const t = setInterval(() => tick(n => n + 1), 30000); return () => clearInterval(t) }, [full.data?.on])

  async function perform(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await work() }
    catch (e) { setError(e instanceof Error ? e.message : '请求失败，请重试') }
    finally { setBusy(false); void full.mutate(); void bold.mutate() }
  }
  const f = full.data
  const left = f?.on ? Math.max(0, f.until - Date.now()) : 0

  return <div className="space-y-6">
    <section data-slot="full-authority">
      <SectionHeader title="全权模式（限时）" description="开启期间，所有需要你确认的操作都自动批准：执行命令、沙箱提权、电脑操作每一步、超维、人格/基因/换代、培养越线。到点自动收回，每次放行都有记录。" />
      <div className="panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-pi-text"><ShieldOff size={18} aria-hidden="true" />
            {full.error ? '读取失败' : !f ? '读取状态…' : f.on ? `已开启 · 还剩 ${remainText(left)}` : '未开启'}
          </span>
          {f?.on && <button type="button" className="btn-primary min-h-11 px-4" disabled={busy} onClick={() => perform(AuthorityApi.disable)}>立即收回</button>}
        </div>
        {f?.on ? <p className="text-sm text-pi-dim break-words">
          到期时间 {new Date(f.until).toLocaleString()}{f.reason ? ` · 理由：${f.reason}` : ''}。手机和远程页面都能收回。
        </p> : <>
          <div className="flex flex-wrap items-center gap-4 text-sm text-pi-text">
            <label className="inline-flex items-center gap-2">时长
              <ThemedSelect aria-label="全权时长" className="input-pi min-h-11" value={String(hours)} onChange={e => setHours(Number(e.target.value))}>
                {[1, 2, 4, 8].map(h => <option key={h} value={h}>{h} 小时</option>)}
              </ThemedSelect>
            </label>
            <input className="input-pi min-h-11 flex-1 min-w-[12rem]" placeholder="理由（可选，会记在放行记录里）" value={reason} maxLength={200} onChange={e => setReason(e.target.value)} />
          </div>
          <button type="button" className="btn-primary min-h-11 px-4" disabled={busy || !f?.local} onClick={() => perform(() => AuthorityApi.enable(hours, reason.trim()))}>开启全权 {hours} 小时</button>
          {f && !f.local && <p className="text-sm text-pi-dim">请在运行元枢的电脑上打开（http://127.0.0.1:8787 的授权中心）开启；这里可以收回。</p>}
        </>}
        <p className="text-sm leading-relaxed text-pi-dim">
          不在全权范围内的：本来就不弹卡的硬红线（比如往工作区外写文件、策略拒绝），以及手机上由手机自己弹的确认（打电话、发短信等，在手机元枢 App 里管）。打开电脑操作授权本身仍要在电脑上点，开了之后每一步不再问。
        </p>
        {!!f?.ledger?.length && <details>
          <summary className="text-sm text-pi-text cursor-pointer">最近自动放行（{f.ledger.length}）</summary>
          <ul className="mt-2 space-y-1 text-sm text-pi-dim">
            {f.ledger.map((r, i) => <li key={i} className="break-words">{new Date(r.at).toLocaleString()} · {r.toolName || '操作'}{r.reason ? ` · ${r.reason.slice(0, 80)}` : ''}</li>)}
          </ul>
        </details>}
      </div>
    </section>

    <section data-slot="bold-mode">
      <SectionHeader title="大胆模式" description="让她敢拿主意：有判断就直接做、做完再汇报，少列选项、少说免责声明，想法放开，失败了自己换路。全局生效，不跳过任何确认。" />
      <div className="panel space-y-3">
        <label className="inline-flex items-center gap-3 min-h-11 text-sm font-medium text-pi-text">
          <input type="checkbox" checked={!!bold.data?.on} disabled={busy || !bold.data} onChange={e => perform(() => AuthorityApi.setBold(e.target.checked))} />
          <Zap size={16} aria-hidden="true" />{bold.data?.on ? '已开启' : '未开启'}
        </label>
        <p className="text-sm text-pi-dim">只放开元枢自己加的保守约束；密钥外泄、违法内容和模型平台本身禁止的内容不受影响。</p>
      </div>
    </section>
    {error && <p role="alert" className="text-sm text-pi-danger break-words">{error}</p>}
  </div>
}
