import { useState } from 'react'
import type { Overview } from './api'
import type { Action } from './Authorization'

export default function SlotRecovery({ value, sessionId, onAction }: { value: Overview; sessionId: string; onAction: (a: Action) => void }) {
  const [reason, setReason] = useState('宿主已确认原进程结束，释放被占用的后台名额')
  const slot = value.admission
  if (slot?.state !== 'held') return null
  const authorized = !!value.humanGrantAvailable || (!!value.sessionGrantAvailable && !!sessionId)
  const who = slot.consumer === 'cultivation' ? '培养任务' : '知识任务'
  if (!slot.recoveryRequired) return <p role="status" className="soul-notice">后台名额正被{who}占用，仍需等待宿主确认原进程结束；不会按超时自动释放。</p>
  return <section className="soul-notice" aria-label="恢复后台名额" role="status">
    <h4>后台名额被卡住了：{who}的进程已经结束，名额没释放</h4>
    <p>卡住期间新的培养、知识任务都会排不上。点下面的按钮，在当前会话确认一次即可，不需要密码，也不开放电脑权限。只释放本地并发名额，未知费用仍保留。</p>
    <label>恢复理由<input maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    <div className="soul-actions">
      <button disabled={!authorized || !reason.trim()} onClick={() => onAction({ method: 'POST', path: '/resources/reconcile', payload: { slotId: slot.id, reason: reason.trim() }, revision: value.revision, label: '恢复后台名额' })}>核对并申请恢复</button>
    </div>
    {!authorized && <p className="soul-hint">{value.sessionGrantAvailable ? '请先在页面上方选择会话，即可在当前会话确认恢复。' : '当前没有可用的确认方式。'}</p>}
  </section>
}
