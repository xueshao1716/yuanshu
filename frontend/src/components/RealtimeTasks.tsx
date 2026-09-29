import { useEffect, useRef, useState } from 'react'
import { listVoiceTasks, stopVoiceTask, type VoiceTask } from '../realtime/tasks'
import { canStopTask, taskStatusText, visibleProposals, visibleTasks } from '../realtime/task-state.mjs'

type Proposal = { id: string; status: string; tasks: { title: string; instruction: string; dependsOn?: number[] }[] }
type Props = { sessionId?: string | null; ready: boolean; proposals: Proposal[]; notice: string; revision: number
  draft: string; setDraft: (text: string) => void; propose: () => void; confirm: (id: string, approved: boolean) => void }
const proposalStatus: Record<string, string> = { pending: '等待你确认 · 90 秒内有效', submitting: '正在提交，请勿重复操作', accepted: '已受理',
  declined: '已取消，不执行', expired: '确认已过期，未提交', closed: '通话已结束，此提案未提交', uncertain: '回执待核对，请刷新下方任务列表' }

// This content scrolls within the dedicated call screen, not the composer.
export default function RealtimeTasks({ sessionId, ready, proposals, notice, revision, draft, setDraft, propose, confirm }: Props) {
  const [tasks, setTasks] = useState<VoiceTask[] | null>(null), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [stopping, setStopping] = useState<string | null>(null)
  const mounted = useRef(true), stopController = useRef<AbortController | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stopController.current?.abort() } }, [])
  useEffect(() => {
    if (!sessionId) return
    let live = true, timer: ReturnType<typeof setTimeout>, current: AbortController
    const load = async () => {
      current = new AbortController()
      const timeout = setTimeout(() => current.abort(), 12000)
      try { const next = await listVoiceTasks(sessionId, current.signal); if (live) { setTasks(next); setError('') } }
      catch { if (live) setError('任务列表暂时不可用，请刷新重试；不要重复提交已确认的任务。') }
      finally { clearTimeout(timeout); if (live) timer = setTimeout(load, 5000) }
    }
    void load()
    return () => { live = false; clearTimeout(timer); current?.abort() }
  }, [sessionId, revision, refresh])
  async function stop(id: string) {
    if (!sessionId || stopping) return
    setStopping(id); setError('')
    const controller = new AbortController(); stopController.current = controller
    const timeout = setTimeout(() => controller.abort(), 12000)
    try { await stopVoiceTask(sessionId, id, controller.signal); if (mounted.current) setRefresh(n => n + 1) }
    catch { if (mounted.current) setError('停止请求未确认，请刷新任务核对状态。') }
    finally { clearTimeout(timeout); if (mounted.current) setStopping(null) }
  }
  return <section aria-label="通话任务" className="min-w-0 space-y-3 border-t border-pi-border pt-3">
    <h3 className="font-medium">交给元枢</h3>
    <p className="text-sm text-pi-dim2">语音里的“已提交”不算接单。请核对任务并点击确认；已受理任务会排队执行，挂断不取消。</p>
    {ready && <div className="space-y-2">
      <label className="block">任务内容（可修改转写）
        <textarea value={draft} onChange={e => setDraft(e.target.value)} maxLength={12000} rows={3}
          className="mt-2 block w-full resize-y rounded-lg border border-pi-border bg-pi-bg px-3 py-2 text-base text-pi-text"
          placeholder="写下要完成的任务，或从转写中选择“交给元枢”" />
      </label>
      <button type="button" className="btn-tool-sm touch-hit" disabled={!draft.trim()} onClick={propose}>生成任务确认</button>
    </div>}
    <div role="status" aria-live="polite" className="text-sm">{notice}</div>
    {visibleProposals(proposals).map((p: Proposal) => <div key={p.id} className="space-y-2 border-t border-pi-border py-3">
      <p className="font-medium">{proposalStatus[p.status] || '等待状态更新'}</p>
      <ol className="list-inside list-decimal space-y-2">
        {p.tasks.map((task, index) => <li key={index} className="break-words">
          {task.title}
          <p className="whitespace-pre-wrap break-words text-pi-dim2">{task.instruction}</p>
          {!!task.dependsOn?.length && <p className="text-pi-dim2">等待任务 {task.dependsOn.map(i => i + 1).join('、')} 完成</p>}
        </li>)}
      </ol>
      {p.status === 'pending' && <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary touch-hit" disabled={!ready} onClick={() => confirm(p.id, true)}>确认执行</button>
        <button type="button" className="btn-tool-sm touch-hit" disabled={!ready} onClick={() => confirm(p.id, false)}>不执行</button>
      </div>}
    </div>)}
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">当前聊天的任务</h3>
      <button type="button" className="btn-tool-sm touch-hit" disabled={!sessionId} onClick={() => setRefresh(n => n + 1)}>刷新任务</button>
    </div>
    {error && <p role="alert" className="text-pi-danger">{error}</p>}
    {!error && !tasks?.length && <p className="text-pi-dim2">{!sessionId ? '开始通话后绑定当前聊天' : tasks ? '还没有已受理任务' : '正在读取任务…'}</p>}
    {!!tasks?.length && <ul aria-label="已受理任务" className="divide-y divide-pi-border">
      {visibleTasks(tasks).map((task: VoiceTask) => <li key={task.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-3">
        <div className="min-w-0 flex-1 break-words"><p>{task.title}</p><p className="text-sm text-pi-dim2">{taskStatusText(task)}</p></div>
        {canStopTask(task) && <button type="button" className="btn-tool-sm touch-hit" disabled={!!stopping} onClick={() => void stop(task.id)}>{stopping === task.id ? '正在请求停止…' : '停止任务'}</button>}
      </li>)}
    </ul>}
    <p className="text-sm text-pi-dim2">任务与结果持久保存；“执行结束”不等于人工验收通过。切换聊天或刷新后，仍可在原聊天查看。</p>
  </section>
}
