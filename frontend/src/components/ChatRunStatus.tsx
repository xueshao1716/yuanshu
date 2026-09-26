import { useId } from 'react'
import { ChevronDown, ChevronUp, RotateCcw, Square } from 'lucide-react'
import useSWR from 'swr'
import { RunApi, type RunSummary } from '../api'
import WorkExplanation from './WorkExplanation'
import RunContextSummary from './RunContextSummary'
import BackgroundRecoveryStatus from './BackgroundRecoveryStatus'
import TeamDeliveryStatus from './TeamDeliveryStatus'
import { useProcessVisibility } from '../hooks/useProcessVisibility'

export default function ChatRunStatus({ sessionId, onStop, onRetry, onResume }: { sessionId: string | null; onStop?: () => void; onRetry?: (run: RunSummary) => void; onResume?: (run: RunSummary) => void }) {
  const [showStatus, toggleStatus] = useProcessVisibility('runStatus')
  const detailsId = useId()
  const { data, error, mutate } = useSWR(sessionId ? ['chat-run-overview', sessionId] : null, () => RunApi.overview(sessionId || undefined), { refreshInterval: 5000, revalidateOnFocus: true })
  const active = data?.active?.find(run => run.sessionId === sessionId)
  const recent = !active ? data?.recent?.find(run => run.sessionId === sessionId) : undefined
  const run = active || recent
  if (!run && !error) return null
  const failed = run && ['failed', 'stopped', 'interrupted'].includes(run.status)
  const statusLabel = run?.explanation?.status.label || ({ queued: '等待执行', running: '正在执行', stopping: '正在停止', completed: '执行结束', failed: '执行失败', stopped: '已停止', interrupted: '已中断' }[run?.status || ''] || '状态未记录')
  const ToggleIcon = showStatus ? ChevronUp : ChevronDown
  return <section className="mx-auto mb-3 w-full max-w-3xl min-w-0" aria-label="当前运行状态">
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className={`text-xs ${failed ? 'text-pi-danger' : 'text-pi-dim'}`}>{showStatus ? '任务详情' : `任务详情 · ${statusLabel}`}</span>
      <button type="button" onClick={toggleStatus} aria-expanded={showStatus} aria-controls={detailsId} aria-label={showStatus ? '隐藏任务详情' : '显示任务详情'} title={showStatus ? '隐藏任务详情' : '显示任务详情'} className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-pi-md text-pi-dim hover:text-pi-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        <ToggleIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    {error && <p role="alert" className="text-xs text-pi-danger mb-2">工作状态暂时无法刷新{run ? '，以下是上次记录。' : '，请稍后重试。'}</p>}
    <div id={detailsId} hidden={!showStatus}>
    {run && <WorkExplanation key={run.id} run={run} />}
    {run && <BackgroundRecoveryStatus key={`recovery-${run.id}`} run={run} onUpdated={() => { void mutate() }} />}
    {run && <TeamDeliveryStatus key={`delivery-${run.id}`} run={run} />}
    {run && sessionId && <div className="mt-2"><RunContextSummary run={run} sessionId={sessionId} emotionOnly /></div>}
    </div>
    <div className="flex flex-wrap gap-2 mt-1 [&>button]:min-h-11">
      {active && onStop && <button type="button" onClick={onStop} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-border-soft px-2 py-1 text-[11px] text-pi-dim hover:text-pi-text" aria-label="停止运行"><Square className="h-3 w-3" />停止</button>}
      {!active && run?.resumeAvailable && onResume && <button type="button" onClick={() => onResume(run)} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-accent/40 px-2 py-1 text-[11px] text-pi-accent hover:text-pi-text" aria-label="继续运行"><RotateCcw className="h-3 w-3" />继续任务</button>}
      {!active && failed && onRetry && <button type="button" onClick={() => onRetry(run)} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-border-soft px-2 py-1 text-[11px] text-pi-dim hover:text-pi-text" aria-label="重试运行"><RotateCcw className="h-3 w-3" />重试</button>}
    </div>
  </section>
}
