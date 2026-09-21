import useSWR from 'swr'
import { useState } from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDot,
  FileCode2,
  GitCompare,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Square,
  Wrench,
} from 'lucide-react'
import { GitReviewApi, RunApi, RunsApi, type GitReview, type GitReviewFile, type RunOverview, type RunSummary } from '../api'
import { toast } from './Toast'
import RunTimeline from './RunTimeline'

const PHASE_LABELS: Record<string, string> = {
  queued: '排队中',
  thinking: '思考中',
  executing: '工具执行',
  remembering: '整理记忆',
  delivering: '交付中',
  completed: '已完成',
  failed: '执行失败',
  stopped: '已停止',
  interrupted: '可恢复',
}

const FILE_STATUS_LABELS: Record<GitReviewFile['status'], string> = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  untracked: '未跟踪',
}

function formatDuration(durationMs?: number | null) {
  if (!durationMs || durationMs < 1000) return durationMs === 0 ? '不到 1 秒' : '进行中'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

type RunTone = 'error' | 'warning' | 'success' | 'active'

function statusTone(run: RunSummary): RunTone {
  if (['failed', 'stopped'].includes(run.phase) || run.status === 'failed') return 'error'
  if (run.phase === 'interrupted') return 'warning'
  if (run.phase === 'completed') return 'success'
  return 'active'
}

function GitStatusIcon({ status }: { status: GitReviewFile['status'] }) {
  if (status === 'deleted') return <AlertTriangle className="h-3.5 w-3.5 text-pi-error" strokeWidth={1.8} />
  if (status === 'added' || status === 'untracked') return <CircleDot className="h-3.5 w-3.5 text-pi-success" strokeWidth={1.8} />
  return <FileCode2 className="h-3.5 w-3.5 text-pi-accent" strokeWidth={1.8} />
}

function GitSummary({ data, error, onOpenReview }: { data?: GitReview; error?: unknown; onOpenReview?: () => void }) {
  if (error) return <div className="rounded-pi-md border border-pi-border-soft bg-pi-bg2/40 px-3 py-2 text-[11px] text-pi-dim2">改动审查暂不可用</div>
  if (!data) return <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-pi-dim2"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />正在读取改动…</div>
  if (!data.isRepo) return <div className="rounded-pi-md border border-pi-border-soft bg-pi-bg2/40 px-3 py-2 text-[11px] text-pi-dim2">当前工作区还不是 Git 仓库</div>

  const additions = data.files.reduce((sum, file) => sum + (file.additions || 0), 0)
  const deletions = data.files.reduce((sum, file) => sum + (file.deletions || 0), 0)
  const verificationLabel = data.verification.state === 'passed' ? '验收通过' : data.verification.state === 'failed' ? '验收失败' : data.verification.state === 'running' ? '正在验收' : '等待验收'
  const verificationIcon = data.verification.state === 'passed' ? <CheckCircle2 className="h-3.5 w-3.5 text-pi-success" /> : data.verification.state === 'failed' ? <AlertTriangle className="h-3.5 w-3.5 text-pi-error" /> : <CircleDot className="h-3.5 w-3.5 text-pi-dim2" />

  return <section className="rounded-pi-lg border border-pi-border-soft bg-pi-bg1/70 p-3" aria-label="Git 改动摘要">
    <div className="flex items-center gap-2">
      <GitCompare className="h-4 w-4 text-pi-accent" strokeWidth={1.8} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-pi-text">工作区改动</div>
        <div className="truncate text-[10px] text-pi-dim2" title={data.branch || undefined}>{data.branch || '当前分支未知'}</div>
      </div>
      {onOpenReview && <button type="button" onClick={onOpenReview} className="inline-flex min-h-8 items-center gap-1 rounded-pi-md border border-pi-border-soft px-2 text-[11px] text-pi-dim hover:border-pi-accent/40 hover:text-pi-text"><GitCompare className="h-3.5 w-3.5" />完整审查</button>}
    </div>
    <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
      <div className="rounded-pi-md bg-pi-bg2/60 px-1.5 py-2"><div className="text-sm font-semibold text-pi-text">{data.files.length}</div><div className="text-[10px] text-pi-dim2">文件</div></div>
      <div className="rounded-pi-md bg-pi-bg2/60 px-1.5 py-2"><div className="text-sm font-semibold text-pi-success">+{additions}</div><div className="text-[10px] text-pi-dim2">新增行</div></div>
      <div className="rounded-pi-md bg-pi-bg2/60 px-1.5 py-2"><div className="text-sm font-semibold text-pi-error">-{deletions}</div><div className="text-[10px] text-pi-dim2">删除行</div></div>
    </div>
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-pi-dim2">{verificationIcon}<span>{verificationLabel}</span>{data.diffTruncated && <span className="ml-auto text-pi-warning">差异已截断</span>}</div>
    {data.files.length > 0 && <div className="mt-2 space-y-0.5 border-t border-pi-border-soft pt-2">
      {data.files.slice(0, 5).map(file => <div key={`${file.status}:${file.path}`} className="flex items-center gap-1.5 rounded-pi-sm px-1 py-1 text-[11px] text-pi-dim hover:bg-pi-bg2/60">
        <GitStatusIcon status={file.status} />
        <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
        <span className="shrink-0 text-[10px] text-pi-dim2">{FILE_STATUS_LABELS[file.status]}</span>
      </div>)}
      {data.files.length > 5 && <div className="px-1 pt-1 text-[10px] text-pi-dim2">还有 {data.files.length - 5} 个文件…</div>}
    </div>}
  </section>
}

function RunCard({ run, active, onOpenSession, mutate }: { run: RunSummary; active: boolean; onOpenSession?: (sessionId: string) => void; mutate: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const tone = statusTone(run)
  const stop = async () => {
    if (busy) return
    setBusy(true)
    try { await RunsApi.stop(run.id); toast('任务已停止', 'ok'); await mutate() }
    catch (error: any) { toast(`停止失败：${error?.message || '请重试'}`, 'error') }
    finally { setBusy(false) }
  }
  const resume = async () => {
    if (busy) return
    setBusy(true)
    try {
      await RunsApi.resume(run.id)
      toast('任务已继续', 'ok')
      onOpenSession?.(run.sessionId)
      await mutate()
    } catch (error: any) { toast(`继续失败：${error?.message || '请重试'}`, 'error') }
    finally { setBusy(false) }
  }

  return <section className={`rounded-pi-lg border p-3 ${tone === 'error' ? 'border-pi-error/30 bg-pi-error/5' : tone === 'warning' ? 'border-pi-warning/30 bg-pi-warning/5' : 'border-pi-border-soft bg-pi-bg1/70'}`} aria-label="任务运行状态">
    <div className="flex items-center gap-2">
      {active ? <LoaderCircle className="h-4 w-4 animate-spin text-pi-accent" /> : tone === 'success' ? <Check className="h-4 w-4 text-pi-success" /> : tone === 'error' ? <AlertTriangle className="h-4 w-4 text-pi-error" /> : <RotateCcw className="h-4 w-4 text-pi-warning" />}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-pi-text">{active ? '当前任务' : '最近任务'}</div>
        <div className="truncate text-[10px] text-pi-dim2">{PHASE_LABELS[run.phase] || run.phase}</div>
      </div>
      {onOpenSession && <button type="button" onClick={() => onOpenSession(run.sessionId)} className="min-h-8 rounded-pi-md border border-pi-border-soft px-2 text-[11px] text-pi-dim hover:text-pi-text">打开会话</button>}
    </div>
    <div className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-pi-text/90">{run.messagePreview || (active ? '正在处理…' : '任务没有可显示的摘要')}</div>
    <div className="mt-2"><RunTimeline phase={run.phase} /></div>
    <div className="mt-2 grid grid-cols-3 gap-1.5 text-center text-[10px] text-pi-dim2">
      <div className="rounded-pi-md bg-pi-bg2/60 px-1 py-1.5"><div className="text-[12px] text-pi-text">{run.toolCount}</div>工具</div>
      <div className="rounded-pi-md bg-pi-bg2/60 px-1 py-1.5"><div className="text-[12px] text-pi-text">{run.memoryCount}</div>记忆</div>
      <div className="rounded-pi-md bg-pi-bg2/60 px-1 py-1.5"><div className="text-[12px] text-pi-text">{formatDuration(run.durationMs)}</div>耗时</div>
    </div>
    {run.error && <div className="mt-2 rounded-pi-md border border-pi-error/20 bg-pi-error/5 px-2.5 py-2 text-[11px] leading-relaxed text-pi-error">{run.error}</div>}
    {(active || run.resumeAvailable) && <div className="mt-2 flex gap-2">
      {active && <button type="button" disabled={busy} onClick={stop} className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-pi-md border border-pi-border-soft px-2 text-[11px] text-pi-dim hover:text-pi-text disabled:opacity-50"><Square className="h-3.5 w-3.5" />{busy ? '处理中…' : '停止任务'}</button>}
      {!active && run.resumeAvailable && <button type="button" disabled={busy} onClick={resume} className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-pi-md border border-pi-accent/40 px-2 text-[11px] text-pi-accent hover:bg-pi-accent/10 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />{busy ? '处理中…' : '继续任务'}</button>}
    </div>}
  </section>
}

export default function TaskInspector({ onOpenSession, onOpenReview }: { onOpenSession?: (sessionId: string) => void; onOpenReview?: () => void }) {
  const { data: runData, error: runError, mutate: mutateRuns } = useSWR<RunOverview>('utility-run-overview', () => RunApi.overview(), { refreshInterval: 4000, revalidateOnFocus: false })
  const { data: gitData, error: gitError, mutate: mutateGit } = useSWR<GitReview>('utility-git-review', () => GitReviewApi.review(), { refreshInterval: 12000, revalidateOnFocus: false })
  const active = runData?.active?.[0]
  const recent = !active ? runData?.recent?.[0] : undefined
  const run = active || recent
  const health = runData?.health
  const healthLabel = health?.activeCount
    ? '引擎工作中'
    : health?.failedCount
      ? '当前空闲 · 有历史异常'
      : '引擎空闲'

  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3" data-slot="task-inspector">
    <div className="mb-3 flex items-start gap-2">
      <div className="min-w-0 flex-1"><div className="text-[13px] font-semibold text-pi-text">任务检查</div><div className="mt-0.5 text-[11px] text-pi-dim2">运行状态、恢复动作与工作区验收</div></div>
      <button type="button" title="刷新任务检查" aria-label="刷新任务检查" onClick={() => { void mutateRuns(); void mutateGit() }} className="btn-tool !h-8 !w-8 !p-0"><RefreshCw className="h-3.5 w-3.5" /></button>
    </div>
    <div className="mb-3 flex items-center gap-2 rounded-pi-md border border-pi-border-soft bg-pi-bg2/50 px-2.5 py-2 text-[11px]">
      <span className={`h-2 w-2 rounded-full ${health?.status === 'busy' ? 'bg-pi-accent animate-pulse' : health?.status === 'degraded' ? 'bg-pi-warning' : 'bg-pi-dim2'}`} />
      <span className="text-pi-text">{healthLabel}</span>
      {health && <span className="ml-auto text-[10px] text-pi-dim2">{health.activeCount} 个执行中 · {health.failedCount} 个异常</span>}
    </div>
    {runError ? <div className="mb-3 rounded-pi-md border border-pi-error/25 bg-pi-error/5 px-3 py-2 text-[11px] text-pi-error">运行状态暂不可用，请稍后刷新。</div> : run ? <RunCard run={run} active={!!active} onOpenSession={onOpenSession} mutate={() => mutateRuns()} /> : <div className="mb-3 rounded-pi-lg border border-dashed border-pi-border-soft px-3 py-5 text-center text-[11px] text-pi-dim2"><Wrench className="mx-auto mb-2 h-5 w-5" />当前没有运行中的任务</div>}
    <GitSummary data={gitData} error={gitError} onOpenReview={onOpenReview} />
  </div>
}
