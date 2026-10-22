import { useSWRConfig } from 'swr'
import useSWR from 'swr'
import { JobsApi, type BackgroundJob } from '../api'
import { ListChecks, X, LoaderCircle } from 'lucide-react'

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 后台作业（2026-10-23）：让"她派出去的活"可见，而不是黑箱 */
export default function JobsCard() {
  const { data } = useSWR('background-jobs', () => JobsApi.list(), { refreshInterval: 5000, revalidateOnFocus: false })
  const { mutate } = useSWRConfig()
  const jobs: BackgroundJob[] = (data?.jobs || []).slice(0, 8)
  const running = data?.running || 0
  const queued = data?.queued || 0

  const cancel = async (id: string) => {
    try { await JobsApi.cancel(id); await mutate('background-jobs') } catch {}
  }

  return (
    <section className="settings-card" aria-label="后台任务">
      <div className="sc-head">
        <ListChecks className="h-4 w-4" strokeWidth={1.8} />
        <h3>后台任务</h3>
        <span className="sc-role">
          {running ? `${running} 个在跑` : '空闲'}
          {queued ? ` · ${queued} 个排队` : ''}
          {data ? ` · 并发上限 ${data.concurrency}` : ''}
        </span>
      </div>
      {!jobs.length ? (
        <p className="sc-desc">没有后台作业。她派出去的重活（dsh 任务）会登记在这里。</p>
      ) : (
        <ul className="jobs-list">
          {jobs.map((j) => (
            <li key={j.id} className={`jobs-row jobs-${j.status}`}>
              <span className="jobs-status">
                {j.status === 'running' ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : null}
                {STATUS_TEXT[j.status] || j.status}
              </span>
              <span className="jobs-title" title={j.title}>{j.title}</span>
              <span className="jobs-meta">
                {j.durationMs ? `${Math.round(j.durationMs / 1000)}s` : ''}
                {j.error ? ` · ${j.error.slice(0, 40)}` : ''}
              </span>
              {j.status === 'running' || j.status === 'queued' ? (
                <button type="button" onClick={() => cancel(j.id)} title="取消">
                  <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
