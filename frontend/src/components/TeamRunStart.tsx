import { useRef, useState } from 'react'
import { SessionsApi, TeamRunApi } from '../api'
import { useApp } from '../store'
import { useHashRoute } from '../hooks/useHashRoute'

export function TeamRunStart({ running = false }: { running?: boolean }) {
  const { currentSessionId, selectSession, refreshSessions } = useApp()
  const [, nav] = useHashRoute(['chat', 'review'])
  const [task, setTask] = useState('')
  const [workflow, setWorkflow] = useState<'team-general' | 'team-video'>('team-general')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ task: string; sessionId: string; clientRequestId: string; workflow: 'team-general' | 'team-video' } | null>(null)
  const submitting = useRef(false)
  const taskLimit = workflow === 'team-general' ? 6000 : 300
  async function start() {
    if (submitting.current || running || !task.trim()) return
    if (task.length > taskLimit || (workflow === 'team-video' && /[\r\n]/.test(task))) {
      setError(`请填写不超过 ${taskLimit} 字${workflow === 'team-video' ? '的单行' : '的'}任务`)
      return
    }
    submitting.current = true; setBusy(true); setError('')
    try {
      // Retain the same request after a network failure; retry must not buy a second run.
      if (!pending.current) {
        const sessionId = currentSessionId || (await SessionsApi.create('天团协作')).id
        pending.current = { task: task.trim(), sessionId, clientRequestId: crypto.randomUUID(), workflow }
      }
      const result = await TeamRunApi.start(pending.current)
      pending.current = null
      selectSession(result.sessionId)
      nav('chat')
      void refreshSessions()
    } catch (e) { setError(e instanceof Error ? e.message : '提交失败，请重试同一请求') }
    finally { submitting.current = false; setBusy(false) }
  }
  return <div className="panel p-3 flex flex-col gap-3">
    <label htmlFor="team-task" className="text-sm font-semibold text-pi-text">让天团协作</label>
    <label className="text-sm text-pi-text">协作类型
      <select aria-label="协作类型" value={workflow} disabled={busy || !!pending.current} onChange={e => setWorkflow(e.target.value as typeof workflow)} className="input min-h-11 w-full mt-2">
        <option value="team-general">通用协作：策划、脚本、方案</option>
        <option value="team-video">视频专用：10 秒、3 镜头送审</option>
      </select>
    </label>
    <p className="text-sm text-pi-dim">通用协作依次完成方案、质疑、正文和复核，交付文件回到当前会话，在任务验收中核对。视频专用沿用原送审流程。聊天中可用 /team 加需求启动通用协作。</p>
    <textarea id="team-task" value={task} rows={4} maxLength={taskLimit} disabled={busy || !!pending.current} onChange={e => setTask(e.target.value)} placeholder="写清目标、限制，以及要交付的脚本或方案" aria-describedby="team-task-limit" className="min-h-11 rounded-pi-md bg-pi-bg2 px-3 py-2 text-sm text-pi-text focus-visible:outline focus-visible:outline-pi-accent" />
    <p id="team-task-limit" className="text-xs text-pi-dim">{task.length}/{taskLimit} 字{workflow === 'team-video' ? ' · 视频任务请填写单行' : ' · 可分行填写详细要求'}</p>
    <button type="button" onClick={start} disabled={busy || running || !task.trim()} className="btn-primary min-h-11 px-3 text-sm self-start disabled:opacity-50 focus-visible:outline focus-visible:outline-pi-accent">{busy ? '正在提交…' : pending.current ? '重试同一请求' : running ? '已有天团任务执行中' : '开始协作并打开会话'}</button>
    {error && <p role="alert" className="text-sm text-pi-danger break-words">{error}</p>}
  </div>
}
