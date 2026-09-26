import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'
import { streamSession, getApiBase } from '../../api'
import { useApp } from '../../store'
import { useXiaoyuEmotion } from '../../lib/useXiaoyuEmotion'
import { CompanionApi, type Trigger } from './companion-api'
import { acceptDecision, actionFor, shouldAutoDecide, isConversationEvent, type CompanionDecision } from './companion-state.mjs'

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
  const abort = useRef<AbortController | null>(null)
  const active = enabled && visible && authed
  const contextEpoch = useMemo(() => crypto.randomUUID(), [sessionId, base, token, active, messageEpoch])
  const { data, error, mutate } = useSWR(authed && sessionId ? ['companion-facts', sessionId, base, token] : null,
    async ([, id]) => ({ value: await CompanionApi.facts(id), receivedAt: Date.now() }),
    { refreshInterval: active ? 5000 : 0, revalidateOnFocus: true, dedupingInterval: 500 })
  const prefs = useSWR(authed ? ['companion-preferences', base, token] : null, CompanionApi.preferences, { refreshInterval: active ? 20000 : 0 })
  const facts = !error && data?.value.sessionId === sessionId && clock - data.receivedAt < 15000 ? data.value : null
  const current = useRef({ sessionId, contextEpoch, facts, visible: active, now: clock })
  current.current = { sessionId, contextEpoch, facts, visible: active, now: clock }
  const accepted = acceptDecision(decision, current.current) ? decision : null
  const lastAuto = useRef('')
  const dnd = prefs.data?.dnd ?? true

  useEffect(() => {
    const change = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', change)
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => { document.removeEventListener('visibilitychange', change); clearInterval(timer) }
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
      setMessageEpoch(v => v + 1); void mutate()
    }
    const stop = streamSession(sessionId, 0, ev => {
      if (!isConversationEvent(ev)) return
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
        interactionId: crypto.randomUUID(), trigger, text, visible: true }, controller.signal)
      if (controller !== abort.current || basis.contextEpoch !== current.current.contextEpoch) return
      if (result.status === 'ok' && acceptDecision(result.decision, { ...current.current, now: Date.now() })) setDecision(result.decision!)
      else if (trigger !== 'auto') setFeedback(result.status === 'rate_limited' || result.status === 'busy'
        ? '互动过于频繁或仍在处理，请稍后再试。' : result.status === 'stale' ? '会话状态已变化，请重新互动。' : '本次互动暂不可用，没有生成替代回复。')
    } catch {
      if (controller === abort.current && basis.contextEpoch === current.current.contextEpoch && trigger !== 'auto') setFeedback('互动未完成，请稍后重试；主任务不受影响。')
    } finally {
      clearTimeout(timeout)
      if (controller === abort.current) { abort.current = null; setPending(false) }
    }
  }, [])
  const inputKey = `${contextEpoch}:${facts?.serverEpoch}:${facts?.revision}:${emotion.snapshot?.serverEpoch}:${emotion.snapshot?.revision}`
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
  return { sessionId, emotion, facts, decision: accepted, action: actionFor(facts, accepted), pending, feedback,
    dnd, preferencesReady: !!prefs.data && !prefs.error, setDnd, interact, dismiss: () => setDecision(null) }
}
