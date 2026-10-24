import { useState } from 'react'
import useSWR from 'swr'
import { BriefApi, WeatherApi, type MorningBrief, type WeatherNow } from '../api'
import { RefreshCw, X, CloudRain, Sun, Cloud, CloudSun, CloudFog, Snowflake, CloudLightning } from 'lucide-react'

const WEATHER_ICON = {
  sun: Sun, 'sun-cloud': CloudSun, cloud: Cloud, fog: CloudFog,
  drizzle: CloudRain, rain: CloudRain, snow: Snowflake, storm: CloudLightning,
} as const

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function weatherLine(w: WeatherNow | undefined) {
  if (!w || w.error) return null
  const Icon = WEATHER_ICON[w.icon] || Cloud
  return { Icon, w }
}

/**
 * 今晨面板（2026-10-24 重排）
 *
 * 之前是「一行行 bullet」的列表，读起来像日志；现在拆成两层信息：
 * 左：天气（一眼看到冷暖雨晴）  右：昨晚发生了什么 + 今天要处理什么
 * 底部只留运行指标，密度靠排版而不是靠堆字。
 */
export default function MorningPanel() {
  const [hidden, setHidden] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const { data, mutate, isValidating } = useSWR<MorningBrief>('morning-brief', () => BriefApi.today(), { revalidateOnFocus: false, dedupingInterval: 60_000 })
  const { data: weather } = useSWR<WeatherNow>('weather-now', () => WeatherApi.now(), { revalidateOnFocus: false, dedupingInterval: 15 * 60_000 })

  if (hidden) return null
  const wx = weatherLine(weather)
  const WIcon = wx?.Icon
  const lines = data?.lines || []
  // 待处理事项：承诺逾期 + 慢请求（这两类需要人看，其余是"已发生"的陈述）
  const pending: string[] = []
  if (data?.promises?.overdue?.length) pending.push(`${data.promises.overdue.length} 件承诺逾期`)
  if (data?.promises?.pending) pending.push(`账上 ${data.promises.pending} 件答应过的事`)
  if (data?.slow?.count) pending.push(`24h ${data.slow.count} 次慢请求`)
  const facts = lines.filter((l) => !pending.some((p) => l.includes(p.split(' ')[0]))).slice(0, 4)

  const refresh = async () => {
    setRefreshing(true)
    try { await mutate(await BriefApi.today(true), { revalidate: false }) } catch {}
    finally { setRefreshing(false) }
  }

  const today = new Date()
  const dateText = `${today.getMonth() + 1} 月 ${today.getDate()} 日 · 周${WEEK[today.getDay()]}`

  return (
    <section className="morning" aria-label="今晨">
      <header className="morning-head">
        <span className="morning-kicker">今晨</span>
        <span className="morning-date">{dateText}</span>
        {data?.headline && <span className={`morning-flag ${data.headline === '一切正常' ? 'ok' : 'warn'}`}>{data.headline}</span>}
        <span className="morning-actions">
          <button type="button" onClick={refresh} disabled={refreshing || isValidating} title="重新生成">
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.8} />
          </button>
          <button type="button" onClick={() => setHidden(true)} title="今天不再显示">
            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
          </button>
        </span>
      </header>

      <div className="morning-grid">
        {wx && (
          <div className="morning-weather">
            <div className="mw-main">
              {WIcon && <WIcon className="mw-icon" strokeWidth={1.5} aria-hidden="true" />}
              <span className="mw-temp">{wx.w.temp}<sup>°</sup></span>
            </div>
            <div className="mw-meta">
              <span className="mw-place">{wx.w.place}</span>
              <span className="mw-text">{wx.w.text}{wx.w.high != null && wx.w.low != null ? ` ${wx.w.low}–${wx.w.high}°` : ''}</span>
              <span className="mw-sub">体感 {wx.w.feels}° · 风 {wx.w.wind}km/h{wx.w.rain != null ? ` · 降水 ${wx.w.rain}%` : ''}</span>
            </div>
            {wx.w.hint && <p className="mw-hint">{wx.w.hint}</p>}
          </div>
        )}

        <div className="morning-body">
          {facts.length > 0 ? (
            <ul className="morning-facts">
              {facts.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          ) : (
            <p className="morning-empty">昨晚没有需要留意的记录。</p>
          )}
          {pending.length > 0 && (
            <div className="morning-todo">
              <span className="mt-label">等你</span>
              {pending.map((p, i) => <span key={i} className="mt-chip">{p}</span>)}
            </div>
          )}
        </div>
      </div>

      {data && (() => {
        // 2026-10-24：底部只放"正文没提到的维度"，避免和上面的要点/待办重复
        const extras: string[] = []
        if (data.probe) {
          const raw = String(data.probe)
          const human = (ms: number) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${(ms / 1000).toFixed(1)} 秒`)
          const text = raw.replace(/(\d{4,})(?=ms|→)/g, (_m, n) => human(Number(n))).replace(/(分钟|秒)ms/g, "$1")
          extras.push(`试验：${text.split('·').slice(-1)[0].trim()}`)
        }
        const sealed = (data.lines || []).find((l) => l.includes('封存窗口'))
        if (sealed) extras.push(sealed.replace(/^有 /, '').replace(/（.*?）/, ''))
        if (!extras.length) return null
        return (
          <footer className="morning-foot">
            {extras.map((x, i) => <span key={i}>{x}</span>)}
          </footer>
        )
      })()}
    </section>
  )
}
