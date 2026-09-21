import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { TeamRunApi, type TeamLaunch } from '../api'

export function TeamRunControls({ launch }: { launch?: TeamLaunch | null }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { mutate } = useSWRConfig()
  if (!launch?.id) return null
  const canStop = ['running', 'launching'].includes(launch.status)
  const canResume = ['failed', 'stopped', 'interrupted'].includes(launch.status)
  if (!canStop && !canResume) return null
  async function act() {
    if (busy || !launch?.id) return
    setBusy(true); setError('')
    try {
      if (canStop) await TeamRunApi.stop(launch.id)
      else await TeamRunApi.resume(launch.id)
      await mutate('team-run')
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请刷新后核对运行状态') }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col items-start gap-2">
    <button type="button" disabled={busy} onClick={act} className="btn-secondary min-h-11 px-3 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-pi-accent">
      {busy ? '正在提交…' : canStop ? '停止后续步骤' : '从保存的步骤恢复'}
    </button>
    <p className="text-sm text-pi-dim">已完成的步骤会复用；结果不确定的调用不会自动重跑。停止不能保证撤销已经发生的远端计费。</p>
    {error && <p role="alert" className="text-sm text-pi-danger break-words">{error}</p>}
  </div>
}
