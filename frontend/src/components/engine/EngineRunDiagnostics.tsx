import { useState } from 'react'
import { ArrowUpRight, TriangleAlert } from 'lucide-react'
import type { RunOverview } from '../../api'
import RunTimeline from '../run/RunTimeline'
import WorkExplanation from '../WorkExplanation'

export default function EngineRunDiagnostics({ data, error, onOpenSession }: { data?: RunOverview; error?: unknown; onOpenSession: (id: string) => void }) {
  const [failuresOnly, setFailuresOnly] = useState(false)
  const recent = data?.recent || []
  const failures = recent.filter(run => run.status === 'failed' || run.status === 'interrupted')
  const rows = failuresOnly ? failures : recent
  const names: Record<string, string> = { queued: '排队中', running: '运行中', stopping: '正在停止', completed: '已完成', failed: '失败', interrupted: '已中断', stopped: '已停止' }
  return <section className="border-t border-pi-border-soft py-5" aria-labelledby="engine-runs-title">
    <div className="flex flex-wrap justify-between items-center gap-3 mb-3">
      <h2 id="engine-runs-title" className="text-sm font-semibold text-pi-text">运行诊断</h2>
      <label className="flex items-center gap-2 min-h-11 text-sm text-pi-dim cursor-pointer"><input type="checkbox" checked={failuresOnly} onChange={e => setFailuresOnly(e.target.checked)} />仅看失败与中断</label>
    </div>
    {error ? <p role="alert" className="text-sm text-pi-danger mb-3">运行观测暂不可用{data ? '，以下为上次数据' : '，请刷新重试'}。</p> : !data ? <p role="status" className="text-sm text-pi-dim">正在加载运行记录...</p> : null}
    {data && <p className="text-sm text-pi-dim mb-3">最近 {recent.length} 次运行 · {failures.length} 次失败或中断</p>}
    {!!data?.active.length && <div className="mb-4">
      <h3 className="text-sm text-pi-text font-medium mb-2">当前运行</h3>
      {data.active.map(run => <div key={run.id} className="flex flex-wrap items-center gap-3 py-2">
        <RunTimeline phase={run.phase} compact /><span className="text-sm text-pi-text break-words min-w-0 flex-1">{run.messagePreview || '正在处理任务'}</span>
      </div>)}
    </div>}
    <div className="divide-y divide-pi-border-soft">
      {rows.map(run => <details key={run.id} className="py-1">
        <summary className="cursor-pointer min-h-11 py-3 text-sm text-pi-text break-words">
          <span className={run.status === 'failed' || run.status === 'interrupted' ? 'text-pi-danger' : 'text-pi-dim'}>{names[run.status] || '未知状态'}</span>
          <span className="ml-3">{run.messagePreview || '未记录任务摘要'}</span>
        </summary>
        <div className="pb-4 text-sm space-y-2">
          <WorkExplanation run={run} />
          {run.error && <p className="text-pi-danger break-words flex items-start gap-2"><TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" /><span className="min-w-0 break-all">{run.error}</span></p>}
          <p className="text-pi-dim">工具执行 {run.toolCount} 次</p>
          <p className="text-xs text-pi-dim break-all">运行 {run.id}</p>
          <button type="button" className="btn-ghost min-h-11" disabled={!run.sessionId} onClick={() => onOpenSession(run.sessionId)}>打开会话<ArrowUpRight className="w-4 h-4" /></button>
        </div>
      </details>)}
    </div>
    {data && !rows.length && <p role="status" className="text-sm text-pi-dim py-4">{failuresOnly ? '最近记录中没有失败或中断' : '尚无运行记录'}</p>}
  </section>
}
