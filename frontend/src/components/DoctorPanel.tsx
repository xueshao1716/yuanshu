import useSWR from 'swr'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { SystemApi } from '../api'
import SectionHeader from './SectionHeader'

// 环境体检：安装完或换电脑后，一眼看清各组件是否就位。只读探测，不改任何东西。
const DOT: Record<string, string> = { ok: 'bg-pi-green', warn: 'bg-pi-yellow', fail: 'bg-pi-red' }
const WORD: Record<string, string> = { ok: '正常', warn: '注意', fail: '需处理' }

export default function DoctorPanel() {
  const { data, error, isLoading, mutate } = useSWR('system-doctor', () => SystemApi.doctor(), { revalidateOnFocus: false, dedupingInterval: 60000 })
  const s = data?.summary
  return (
    <section data-slot="system-doctor" className="mb-8">
      <SectionHeader
        title="环境体检"
        description={s ? `${s.ok} 项正常${s.warn ? ` · ${s.warn} 项注意` : ''}${s.fail ? ` · ${s.fail} 项需处理` : ''}` : '检查运行时、引擎、工具与工作区是否就位。'}
        actions={<button className="btn-ghost min-h-11 inline-flex items-center gap-1.5 px-3" onClick={() => mutate()} disabled={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />重新检查</button>}
      />
      <div className="panel !p-0 overflow-hidden">
        {error && <div className="px-4 py-3 text-xs text-pi-red">体检失败：{String(error?.message || error)}</div>}
        {!data && !error && <div className="px-4 py-3 text-xs text-pi-dim2">正在检查…（首次约 10 秒）</div>}
        {data?.items.map((it) => (
          <div key={it.key} className="flex items-start gap-3 px-4 py-2.5 border-b border-pi-border-soft last:border-none">
            <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${DOT[it.status] || 'bg-pi-dim2'}`} aria-hidden />
            <span className="w-32 flex-shrink-0 text-xs text-pi-text">{it.label}</span>
            <span className="flex-1 min-w-0 text-xs text-pi-dim break-all">{it.detail}</span>
            <span className="flex-shrink-0 text-[11px] text-pi-dim2">{WORD[it.status] || it.status}</span>
          </div>
        ))}
      </div>
      <AddonList />
    </section>
  )
}

// 可选组件：安装包不带，用到时联网装（国内镜像直连）。小语缺组件时也会自己装。
function AddonList() {
  const { data, mutate } = useSWR('system-addons', () => SystemApi.addons(), {
    revalidateOnFocus: false,
    refreshInterval: (d) => (d && Object.values(d.jobs).some((j) => j.state === 'running') ? 2000 : 0),
  })
  if (!data) return null
  const install = async (id: string) => { await SystemApi.installAddon(id); mutate() }
  return (
    <div className="mt-4">
      <div className="mb-2 text-xs text-pi-dim">可选组件 · 用到时再装，需要联网</div>
      <div className="panel !p-0 overflow-hidden">
        {data.addons.map((a) => {
          const job = data.jobs[a.id]
          const running = job?.state === 'running'
          return (
            <div key={a.id} className="flex items-start gap-3 px-4 py-2.5 border-b border-pi-border-soft last:border-none">
              <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${a.installed ? 'bg-pi-green' : 'bg-pi-dim2'}`} aria-hidden />
              <span className="w-32 flex-shrink-0 text-xs text-pi-text">{a.label}</span>
              <span className="flex-1 min-w-0 text-xs text-pi-dim">
                {a.use}
                {running && job.log.length > 0 && <span className="block text-pi-dim2 break-all">{job.log[job.log.length - 1]}</span>}
                {job?.state === 'error' && <span className="block text-pi-red break-all">{job.error}</span>}
              </span>
              {a.installed
                ? <span className="flex-shrink-0 text-[11px] text-pi-dim2">已安装</span>
                : <button className="btn-ghost flex-shrink-0 inline-flex items-center gap-1 px-2 text-[11px]" disabled={running} onClick={() => install(a.id)}>
                    {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                    {running ? '安装中' : `安装 · ${a.size}`}
                  </button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
