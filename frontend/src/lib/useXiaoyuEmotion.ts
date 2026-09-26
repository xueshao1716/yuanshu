// 小语此刻心情：对话顶栏灵珠和工作台潮汐共用同一份快照（不带 session）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { EmotionApi, getApiBase } from '../api'
import { useApp } from '../store'
import { emoMeta, type EmoMeta } from './emotion'
import { createEmotionReceiver, emotionConnectionStatus } from './emotion-snapshot.mjs'

export const EMO_LIVE_KEY = 'emotion-live'

const FALLBACK_META: EmoMeta = { emoji: '·', label: '暂无情绪观测', cls: 'unknown' }
export function useXiaoyuEmotion() {
  const { token, authed } = useApp()
  const base = getApiBase()
  const receiver = useMemo(() => createEmotionReceiver(), [base, token])
  const { data, mutate } = useSWR(authed ? [EMO_LIVE_KEY, base, token] : null, async () => {
    const ticket = receiver.begin()
    receiver.receive(ticket, await EmotionApi.display())
    return receiver.read()
  }, {
    // 2026-09-20：8s → 20s。外网每请求 ~0.8s（隧道往返），8 秒轮等于请求永远在飞。
    refreshInterval: 20000,
    revalidateOnFocus: true,
    dedupingInterval: 2000,
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const snapshot = authed ? data?.value ?? null : null
  const status = emotionConnectionStatus(snapshot, now, data?.receivedAt)
  const state = snapshot?.state ?? null
  const meta = state ? emoMeta(state) : FALLBACK_META
  // Old SSE events have no global revision and only invalidate the shared GET.
  const publishEmotion = useCallback((_next: any) => { void mutate() }, [mutate])
  return { state, meta, publishEmotion, snapshot, status }
}
