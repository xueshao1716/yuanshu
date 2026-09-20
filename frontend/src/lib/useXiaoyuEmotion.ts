// 小语此刻心情：对话顶栏灵珠和工作台潮汐共用同一份快照（不带 session）。
import { useCallback } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { EmotionApi } from '../api'
import { emoMeta, type EmoMeta } from './emotion'

export const EMO_LIVE_KEY = 'emotion-live'

const FALLBACK_META: EmoMeta = { emoji: '🧘', label: '专注', cls: 'focus' }

function liveSnap(data: any) {
  if (!data || typeof data.valence === 'undefined') return null
  return data.state && typeof data.state.valence !== 'undefined' ? data.state : data
}

export function useXiaoyuEmotion() {
  const { data } = useSWR(EMO_LIVE_KEY, () => EmotionApi.get(), {
    // 2026-09-20：8s → 20s。外网每请求 ~0.8s（隧道往返），8 秒轮等于请求永远在飞。
    refreshInterval: 20000,
    revalidateOnFocus: true,
    dedupingInterval: 2000,
  })
  const { mutate } = useSWRConfig()
  const state = liveSnap(data)
  const meta = state ? emoMeta(state) : FALLBACK_META
  const publishEmotion = useCallback((next: any) => {
    const snap = liveSnap(next)
    if (!snap) return
    mutate(EMO_LIVE_KEY, snap, { revalidate: false })
  }, [mutate])
  return { state, meta, publishEmotion }
}
