import useSWR from 'swr'
import { SoulApi } from '../soul/api'

/**
 * 昨夜摘要条（2026-10-24）
 *
 * 原先工作台直接塞了灵魂页那份完整「昨夜」块（标题 + 复盘于 + 用时 + 新承诺 …），
 * 一条条竖着堆，跟工作台的横向卡片节奏不搭。这里只留四个可扫读的数字，
 * 想看全文去灵魂培育中心（那儿保留完整版）。
 */
export default function NightStrip() {
  const { data } = useSWR('soul-last-night', SoulApi.lastNight, { refreshInterval: 120_000, revalidateOnFocus: false })
  const task = data?.task
  const entry = data?.entry
  const dream = (data as { dream?: { skillEligible?: number } } | undefined)?.dream || {}
  const minutes = task?.durationMs ? Math.round(task.durationMs / 60000) : null
  const exec = entry?.execSummary || ''
  const blocked = /受阻\s*(\d+)/.exec(exec)?.[1]
  const promises = Number.isFinite(data?.commitments?.fresh) ? data.commitments.fresh : null

  if (!data || (!task && !entry)) return null

  return (
    <div className="night-strip" aria-label="昨夜">
      <span className="ns-kicker">昨夜</span>
      {minutes != null && <span className="ns-item"><b>{minutes}</b>分钟复盘</span>}
      {Number(blocked) > 0 && <span className="ns-item is-warn"><b>{blocked}</b>条受阻</span>}
      {(promises ?? 0) > 0 && <span className="ns-item"><b>{promises}</b>条新承诺</span>}
      {(dream?.skillEligible ?? 0) > 0 && <span className="ns-item"><b>{dream.skillEligible}</b>条可回放</span>}
      <a className="ns-link" href="#/soul">看全文 →</a>
    </div>
  )
}
