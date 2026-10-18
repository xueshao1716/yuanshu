import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { streamSession, getApiBase } from '../../api'
import { useApp } from '../../store'
import { useXiaoyuEmotion } from '../../lib/useXiaoyuEmotion'
import { CompanionApi, type Trigger } from './companion-api'
import { acceptDecision, actionFor, shouldAutoDecide, isConversationEvent, proactiveMoments, type CompanionDecision } from './companion-state.mjs'

export function useCompanion(enabled: boolean) {
  const { currentSessionId: sessionId, token, authed } = useApp()
  const base = getApiBase()
  const emotion = useXiaoyuEmotion()
  const [visible, setVisible] = useState(() => !document.hidden)
  const [messageEpoch, setMessageEpoch] = useState(0)
  const [clock, setClock] = useState(Date.now)
  const [decision, setDecision] = useState<CompanionDecision | null>(null)
  const [feedback, setFeedback] = useState('')
  const [pending, setPending] = useState(false)
  const [lastActivityAt, setLastActivityAt] = useState(Date.now)
  const abort = useRef<AbortController | null>(null)
  const active = enabled && visible && authed
  const contextEpoch = useMemo(() => crypto.randomUUID(), [sessionId, base, token, active, messageEpoch])
  const { data, error, mutate } = useSWR(authed && sessionId ? ['companion-facts', sessionId, base, token] : null,
    async ([, id]) => ({ value: await CompanionApi.facts(id), receivedAt: Date.now() }),
    { refreshInterval: active ? 5000 : 0, revalidateOnFocus: true, dedupingInterval: 500 })
  const prefs = useSWR(authed ? ['companion-preferences', base, token] : null, CompanionApi.preferences, { refreshInterval: active ? 20000 : 0 })
  const facts = !error && data?.value.sessionId === sessionId && clock - data.receivedAt < 15000 ? data.value : null
  const current = useRef({ sessionId, contextEpoch, facts, visible: active, now: clock, currentAction: actionFor(facts, null, { now: clock, lastActivityAt }) })
  current.current = { sessionId, contextEpoch, facts, visible: active, now: clock,
    currentAction: actionFor(facts, decision, { now: clock, lastActivityAt }) }
  const accepted = acceptDecision(decision, current.current) ? decision : null
  const lastAuto = useRef('')
  // 2026-10-18：主动互动默认开着（原来默认免打扰，等于从来不主动说话），用户可以在面板里关掉
  const dnd = prefs.data?.dnd ?? false
  // 主动时机：刚打开 / 久别回来 / 刚干完活 / 时段变化 / 连续报错
  const mountedAt = useRef(Date.now())
  const prevBusy = useRef(false)
  const errorStreak = useRef(0)
  const busyNow = Boolean(facts?.currentBusy)
  const justFinished = prevBusy.current && !busyNow
  useEffect(() => { prevBusy.current = busyNow }, [busyNow])

  useEffect(() => {
    const change = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    const activity = () => setLastActivityAt(Date.now())
    document.addEventListener('pointerdown', activity, { passive: true })
    document.addEventListener('keydown', activity, { passive: true })
    document.addEventListener('input', activity, { passive: true })
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => {
      document.removeEventListener('visibilitychange', change)
      document.removeEventListener('pointerdown', activity)
      document.removeEventListener('keydown', activity)
      document.removeEventListener('input', activity)
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    abort.current?.abort(); setDecision(null); setFeedback(''); setPending(false)
    return () => abort.current?.abort()
  }, [contextEpoch])
  useEffect(() => {
    if (!active || !sessionId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => {
      abort.current?.abort(); setDecision(null)
      setLastActivityAt(Date.now())
      setMessageEpoch(v => v + 1); void mutate()
    }
    const stop = streamSession(sessionId, 0, ev => {
      if (!isConversationEvent(ev)) return
      // 连续报错要记账：她该在两次之后开口（不打断任务，因为出错通常已回到空闲）
      if (/error|failed/i.test(String((ev as { type?: string })?.type || ''))) {
        errorStreak.current = Math.min(errorStreak.current + 1, 5)
      }
      abort.current?.abort(); setDecision(null)
      clearTimeout(timer)
      timer = setTimeout(invalidate, 500)
    }, invalidate)
    return () => { stop(); clearTimeout(timer) }
  }, [sessionId, base, token, active, mutate])

  const interact = useCallback(async (trigger: Trigger, text = '') => {
    const basis = current.current
    if (!basis.sessionId || !basis.visible || !basis.facts?.known) { setFeedback('请先选择可用会话，等待状态同步。'); return }
    abort.current?.abort()
    const controller = new AbortController(); abort.current = controller
    const timeout = setTimeout(() => controller.abort(), 15000)
    setPending(true); setFeedback(''); setDecision(null)
    try {
      const result = await CompanionApi.decide({ sessionId: basis.sessionId, contextEpoch: basis.contextEpoch,
        interactionId: crypto.randomUUID(), trigger, text, visible: true, currentAction: basis.currentAction }, controller.signal)
      if (controller !== abort.current || basis.contextEpoch !== current.current.contextEpoch) return
      if (result.status === 'ok' && acceptDecision(result.decision, { ...current.current, now: Date.now() })) setDecision(result.decision!)
      // 人主动搭话说明在场，报错计数清零
      if (trigger !== 'auto') errorStreak.current = 0
      else if (trigger !== 'auto') setFeedback(result.status === 'rate_limited' || result.status === 'busy'
        ? '互动过于频繁或仍在处理，请稍后再试。' : result.status === 'stale' ? '会话状态已变化，请重新互动。' : '本次互动暂不可用，没有生成替代回复。')
    } catch {
      if (controller === abort.current && basis.contextEpoch === current.current.contextEpoch && trigger !== 'auto') setFeedback('互动未完成，请稍后重试；主任务不受影响。')
    } finally {
      clearTimeout(timeout)
      if (controller === abort.current) { abort.current = null; setPending(false) }
    }
  }, [])
  // Re-evaluate ambient interaction once per minute even when no run/revision changed.
  // The server still rate-limits and validates the decision, so this cannot create a
  // task loop or background work storm.
  // 空闲阶段本身也是环境事实：不要等到整分钟才重新评估，否则休息/放空
  // 和主动陪伴会显得“卡住”。服务端仍有 30 秒窗口限频，前端只在阶段
  // 变化时唤起一次模型，不会形成任务循环。
  const idlePhase = Math.floor(Math.max(0, clock - lastActivityAt) / 30_000)
  const moments = proactiveMoments({
    now: clock, mountedAt: mountedAt.current, lastActivityAt,
    wasBusy: justFinished ? true : false, isBusy: busyNow,
    errorStreak: errorStreak.current,
  })
  const inputKey = `${contextEpoch}:${facts?.serverEpoch}:${facts?.revision}:${emotion.snapshot?.serverEpoch}:${emotion.snapshot?.revision}:${idlePhase}:${moments}`
  useEffect(() => {
    if (!shouldAutoDecide({ visible: active, dnd, sessionId, known: !!facts?.known, key: inputKey, previous: lastAuto.current, pending, currentBusy: facts?.currentBusy })) return
    const timer = setTimeout(() => { lastAuto.current = inputKey; void interact('auto') }, 500)
    return () => clearTimeout(timer)
  }, [inputKey, active, dnd, sessionId, facts?.known, facts?.currentBusy, pending, interact])
  useEffect(() => { if (dnd) { abort.current?.abort(); setDecision(null) } }, [dnd])
  const setDnd = async (value: boolean) => {
    abort.current?.abort(); setDecision(null)
    try { await prefs.mutate(await CompanionApi.setDnd(value), false) }
    catch { setFeedback('免打扰设置未保存，请重试。') }
  }
  return { sessionId, emotion, facts, decision: accepted, action: actionFor(facts, accepted, { now: clock, lastActivityAt }), pending, feedback,
    dnd, preferencesReady: !!prefs.data && !prefs.error, setDnd, interact, dismiss: () => setDecision(null) }
}
