import { useState } from 'react'
import { RunsApi, type RunSummary } from '../api'

const reasons: Record<string, string> = {
  approval_required: '涉及人工审批，需检查后手动继续',
  effects_uncertain: '有工具结果尚不确定，需确认后继续',
  effects_unavailable: '工具记录无法校验，需人工检查',
  checkpoint_invalid: '没有完整的安全检查点，需手动继续',
  scope_changed: '工作目录已改变，禁止跨项目自动续跑',
  deadline_reached: '已到自动接续截止时间',
  limit_reached: '已用完自动接续次数',
  team_requires_review: '天团任务需检查阶段结果后手动继续',
  session_busy: '同会话已有其他任务',
  resume_failed: '未能启动接续，请检查后手动继续',
  user_stop: '用户已停止',
  disabled: '自动接续已关闭',
}

export default function BackgroundRecoveryStatus({ run, onUpdated }: { run: RunSummary; onUpdated: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [disabled, setDisabled] = useState(false)
  const policy = run.backgroundRecovery
  if (!policy) return null
  const active = ['queued', 'running', 'stopping'].includes(run.status)
  const enabled = policy.enabled && !disabled
  const deadline = Date.parse(policy.deadlineAt)
  const until = Number.isFinite(deadline) ? new Date(deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const disable = async () => {
    setBusy(true); setError('')
    try { await RunsApi.disableRecovery(run.id); setDisabled(true); onUpdated() }
    catch { setError('未能关闭自动接续，请重试。') }
    finally { setBusy(false) }
  }
  return <div className="mt-2 text-xs text-pi-dim" aria-label="后台接续策略">
    <p>{active ? '任务在后台运行，离开页面不停止。' : '本次后台接续记录：'}{enabled ? `自动接续 ${policy.used}/${policy.maxResumes} 次${until ? `，截止 ${until}` : ''}。` : '自动接续已关闭。'}时间预算在安全轮边界检查。</p>
    {active && enabled && policy.state === 'scheduled' && <p role="status">检查点已保存，即将自动接续。</p>}
    {enabled && policy.state === 'blocked' && <p role="status">{reasons[policy.reason || ''] || '自动接续已暂停，请检查运行记录。'}</p>}
    {active && enabled && <button type="button" disabled={busy} onClick={() => void disable()} className="touch-hit mt-1 rounded-pi-md border border-pi-border-soft px-2 py-1 text-pi-dim hover:text-pi-text" title="本轮继续执行，只关闭之后的自动接续">{busy ? '正在关闭…' : '关闭自动接续'}</button>}
    {error && <p role="alert" className="mt-1 text-pi-danger">{error}</p>}
  </div>
}
