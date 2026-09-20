// 情绪摘要（2026-09-20）：把"实时情绪 + 潮汐 + 感受"合成一条请求。
// 动机：外网每个请求 ~0.8s（隧道往返），而工作台原本要打 3 条（emotion / emotion/tide / emotion/feelings）。
// 用同一个 SWR key，任何组件复用它都只会发一次请求（SWR 自动去重）。
import useSWR from 'swr'

export const EMOTION_SUMMARY_KEY = 'emotion-summary'

export const fetchEmotionSummary = async () =>
  (await fetch('/api/emotion/summary', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('yuanshu_access_token') || '') } })).json()

export function useEmotionSummary(refreshInterval = 120_000) {
  const { data, error, mutate } = useSWR(EMOTION_SUMMARY_KEY, fetchEmotionSummary, { refreshInterval, revalidateOnFocus: false })
  return { summary: data, emotion: data?.emotion, tide: data?.tide, feelings: data?.feelings, error, mutate }
}
