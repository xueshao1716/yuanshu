import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { ConfirmApi, SessionsApi } from '../api'
import { SoulApi } from './api'
import { date, errorText, LoadState } from './shared'

export function SessionChoice({ sessionId, setSessionId, disabled }: {sessionId: string; setSessionId: (sid: string) => void; disabled: boolean}) {
  const sessions = useSWR('soul-sessions', () => SessionsApi.list())
  return <div className="soul-session">
    <label htmlFor="soul-session">确认记录归属</label>
    <select id="soul-session" value={sessionId} disabled={disabled} onChange={e => setSessionId(e.target.value)}>
      <option value="">请选择已有会话</option>
      {sessions.data?.sessions.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
    </select>
    {!sessionId && <a href="#/chat">没有会话？先去对话创建</a>}
    <LoadState error={sessions.error} retry={sessions.mutate} />
  </div>
}
export function Confirmations({sessionId}: {sessionId: string}) {
  const state = useSWR(sessionId ? ['soul-confirmations', sessionId] : null, () => SoulApi.confirmations(sessionId), {refreshInterval: 1000})
  const [error, setError] = useState(''), [answering, setAnswering] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const firstPending = state.data?.items[0]?.id
  useEffect(()=>{if(firstPending) {container.current?.scrollIntoView({block:'start'}); container.current?.focus({preventScroll:true})}},[firstPending])
  const answer = async (id: string, ok: boolean) => {
    setAnswering(id); setError('')
    try { const r = await ConfirmApi.answer(sessionId, id, ok); if (!r.ok) throw new Error('确认已失效，请重新发起'); await state.mutate() }
    catch(e) {setError(errorText(e))} finally {setAnswering('')}
  }
  return <div ref={container} tabIndex={-1} className="soul-confirmations" aria-live="polite">
    {state.error && <p role="alert">确认列表暂不可读；操作不会自动获批。<button onClick={() => void state.mutate()}>重试</button></p>}
    {state.data?.items.map(item => <section key={item.id} className="soul-confirm">
      <h3>需要你确认 · {item.toolName === 'persona-governance' ? '人格定义' : '性格基因'}</h3>
      <p className="soul-preserve">{item.reason}</p><p>有效至 {date(item.expiresAt)}</p>
      {!state.data.canApprove && <p>请在运行元枢的电脑上打开本机页面确认；远程可以查看或拒绝。</p>}
      <div className="soul-actions"><button disabled={!!answering} onClick={() => void answer(item.id, false)}>拒绝本次操作</button>
        <button className="soul-primary" disabled={!state.data.canApprove || !!answering} onClick={() => void answer(item.id, true)}>确认，仅批准这一次</button></div>
    </section>)}
    {error && <p role="alert">{error}</p>}
  </div>
}
