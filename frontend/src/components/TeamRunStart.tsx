import { useRef, useState } from 'react'
import { SessionsApi, TeamRunApi } from '../api'
import { useApp } from '../store'
import { useHashRoute } from '../hooks/useHashRoute'

export function TeamRunStart({ running = false }: { running?: boolean }) {
  const { currentSessionId, selectSession, refreshSessions } = useApp()
  const [, nav] = useHashRoute(['chat', 'review'])
  const [task, setTask] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef<{ task: string; sessionId: string; clientRequestId: string } | null>(null)
  const submitting = useRef(false)
  async function start() {
    if (submitting.current || running || !task.trim()) return
    submitting.current = true; setBusy(true); setError('')
    try {
      // Retain the same request after a network failure; retry must not buy a second run.
      if (!pending.current) {
        const sessionId = currentSessionId || (await SessionsApi.create('天团视频脚本')).id
        pending.current = { task: task.trim(), sessionId, clientRequestId: crypto.randomUUID() }
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
    <p className="text-sm text-pi-dim">当前支持 10 秒、3 镜头视频脚本。沿用当前会话最近一轮内容，草稿回到该会话；未选择会话时自动新建。可以在聊天里用 /team 加需求继续协作。</p>
    <input id="team-task" value={task} maxLength={300} disabled={busy || !!pending.current} onChange={e => setTask(e.target.value)} placeholder="描述场景、人物和风格" className="min-h-11 rounded-pi-md bg-pi-bg2 px-3 text-sm text-pi-text focus-visible:outline focus-visible:outline-pi-accent" />
    <button type="button" onClick={start} disabled={busy || running || !task.trim()} className="btn-primary min-h-11 px-3 text-sm self-start disabled:opacity-50 focus-visible:outline focus-visible:outline-pi-accent">{busy ? '正在提交…' : pending.current ? '重试同一请求' : running ? '已有天团任务执行中' : '开始协作并打开会话'}</button>
    {error && <p role="alert" className="text-sm text-pi-danger break-words">{error}</p>}
  </div>
}
