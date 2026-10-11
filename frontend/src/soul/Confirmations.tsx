import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { ConfirmApi, SessionsApi } from '../api'
import { SoulApi } from './api'
import { date, errorText, LoadState } from './shared'

export function SessionChoice({ sessionId, setSessionId, disabled }: {sessionId: string; setSessionId: (sid: string) => void; disabled: boolean}) {
  const sessions = useSWR('sessions', () => SessionsApi.list())
  // 直接打开灵魂页时没有“当前会话”，回退到最近活动的会话（列表按时间倒序），不让人从几百个里挑。
  const latest = sessions.data?.sessions[0]?.id
  useEffect(() => { if (!sessionId && latest && !disabled) setSessionId(latest) }, [latest, sessionId, disabled])
  return <div className="soul-session">
    <label htmlFor="soul-session">确认记录归属</label>
    <select id="soul-session" value={sessionId} disabled={disabled} onChange={e => setSessionId(e.target.value)}>
      <option value="">请选择已有会话</option>
      {sessions.data?.sessions.map(s => <option key={s.id} value={s.id}>{s.name || s.id}</option>)}
    </select>
    <p className="soul-hint">不用特意选：已默认当前对话。这里的会话只是把确认卡和策略申请挂进哪条对话做记录；待确认总览在授权中心一区收齐，不需要挑会话。</p>
    {!sessionId && <a href="#/chat">没有会话？先去对话创建</a>}
    <LoadState error={sessions.error} retry={sessions.mutate} />
  </div>
}
// 授权中心「等我确认」：全部会话的未决确认卡一次摊开（引擎 agent-pending.mjs 聚合）。
// 卡片自带归属对话，不用人挑会话；本机受限类（人格/基因/电脑/超维）远程只能看和拒。
export function AllConfirmations() {
  const sessions = useSWR('sessions', () => SessionsApi.list())
  const state = useSWR('agent-pending', () => ConfirmApi.pending(), { refreshInterval: 3000 })
  const [error, setError] = useState(''), [answering, setAnswering] = useState('')
  const names = new Map((sessions.data?.sessions || []).map(s => [s.id, s.name || s.id]))
  const answer = async (item: { sessionId: string; id: string; kind: string }, ok: boolean) => {
    setAnswering(item.id); setError('')
    try {
      const r = await ConfirmApi.answer(item.sessionId, item.id, ok)
      if (!r.ok) throw new Error('确认已失效，请返回列表核对')
      await state.mutate()
    } catch (e) { setError(errorText(e)) } finally { setAnswering('') }
  }
  return <div className="soul-confirmations" aria-live="polite">
    {state.error && <p role="alert">确认列表暂不可读；操作不会自动获批。<button onClick={() => void state.mutate()}>重试</button></p>}
    {state.data && !state.data.items.length && <p className="soul-hint" role="status">没有待确认的事·任何会话的小语请求都会出现在这里，不用挑会话。</p>}
    {state.data?.items.map(item => <section key={`${item.sessionId}:${item.id}`} className="soul-confirm">
      <h3>{item.kind} · {names.get(item.sessionId) || `会话 ${item.sessionId.slice(0, 8)}`}</h3>
      <p className="soul-preserve">{item.reason}</p><p>有效至 {date(item.expiresAt)}</p>
      {!item.canApprove && <p role="status">{item.kind}须在运行元枢的电脑上确认；远程可以查看或拒绝。</p>}
      <div className="soul-actions"><button disabled={!!answering} onClick={() => void answer(item, false)}>拒绝本次操作</button>
        <button className="soul-primary" disabled={!item.canApprove || !!answering} onClick={() => void answer(item, true)}>确认，仅批准这一次</button></div>
    </section>)}
    {error && <p role="alert">{error}</p>}
  </div>
}

export function Confirmations({sessionId, active, busy}: {sessionId: string; active: boolean; busy: boolean}) {
  const state = useSWR(active && sessionId ? ['soul-confirmations', sessionId] : null, () => SoulApi.confirmations(sessionId), {refreshInterval: busy ? 1000 : 10000})
  const [error, setError] = useState(''), [answering, setAnswering] = useState('')
  const container = useRef<HTMLDivElement>(null)
  const firstPending = active ? state.data?.items[0]?.id : undefined
  useEffect(()=>{if(firstPending) {container.current?.scrollIntoView({block:'start'}); container.current?.focus({preventScroll:true})}},[firstPending])
  const answer = async (id: string, ok: boolean) => {
    setAnswering(id); setError('')
    try { const r = await ConfirmApi.answer(sessionId, id, ok); if (!r.ok) throw new Error('确认已失效，请重新发起'); await state.mutate() }
    catch(e) {setError(errorText(e))} finally {setAnswering('')}
  }
  if (!active) return null
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
