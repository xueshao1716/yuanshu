import { RotateCcw, Square } from 'lucide-react'
import useSWR from 'swr'
import { RunApi, type RunSummary } from '../api'
import WorkExplanation from './WorkExplanation'
import RunContextSummary from './RunContextSummary'
import BackgroundRecoveryStatus from './BackgroundRecoveryStatus'
import TeamDeliveryStatus from './TeamDeliveryStatus'

export default function ChatRunStatus({ sessionId, onStop, onRetry, onResume }: { sessionId: string | null; onStop?: () => void; onRetry?: (run: RunSummary) => void; onResume?: (run: RunSummary) => void }) {
  const { data, error, mutate } = useSWR(sessionId ? ['chat-run-overview', sessionId] : null, () => RunApi.overview(sessionId || undefined), { refreshInterval: 5000, revalidateOnFocus: true })
  const active = data?.active?.find(run => run.sessionId === sessionId)
  const recent = !active ? data?.recent?.find(run => run.sessionId === sessionId) : undefined
  const run = active || recent
  if (!run && !error) return null
  const failed = run && ['failed', 'stopped', 'interrupted'].includes(run.status)
  return <section className="mx-auto mb-3 w-full max-w-3xl min-w-0" aria-label="当前运行状态">
    {error && <p role="alert" className="text-xs text-pi-danger mb-2">工作状态暂时无法刷新{run ? '，以下是上次记录。' : '，请稍后重试。'}</p>}
    {run && <WorkExplanation key={run.id} run={run} />}
    {run && <BackgroundRecoveryStatus key={`recovery-${run.id}`} run={run} onUpdated={() => { void mutate() }} />}
    {run && <TeamDeliveryStatus key={`delivery-${run.id}`} run={run} />}
    {run && sessionId && <div className="mt-2"><RunContextSummary run={run} sessionId={sessionId} emotionOnly /></div>}
    <div className="flex flex-wrap gap-2 mt-1 [&>button]:min-h-11">
      {active && onStop && <button type="button" onClick={onStop} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-border-soft px-2 py-1 text-[11px] text-pi-dim hover:text-pi-text" aria-label="停止运行"><Square className="h-3 w-3" />停止</button>}
      {!active && run?.resumeAvailable && onResume && <button type="button" onClick={() => onResume(run)} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-accent/40 px-2 py-1 text-[11px] text-pi-accent hover:text-pi-text" aria-label="继续运行"><RotateCcw className="h-3 w-3" />继续任务</button>}
      {!active && failed && onRetry && <button type="button" onClick={() => onRetry(run)} className="inline-flex items-center gap-1 rounded-pi-md border border-pi-border-soft px-2 py-1 text-[11px] text-pi-dim hover:text-pi-text" aria-label="重试运行"><RotateCcw className="h-3 w-3" />重试</button>}
    </div>
  </section>
}
