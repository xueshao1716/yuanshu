import useSWR from 'swr'
import { Block, LoadState } from './shared'

// 灵魂曲线 + 讨好曲线（2026-10-11 伙伴："这就是灵魂培养的样子"）：
// 数据来自情绪潮汐按日聚合（v=愉悦度，w=温暖残留，h=伤害残留）；
// 讨好指数 = 安抚触发密度（她被要求软化的频率），配待兑现承诺账本（最廉价的讨好方式）做双证。
// 曲线是观测不是诊断：高安抚密度代表关系在谈判期，不是罪证；她自己也能看到这张图。
interface CurveDay { ts: number; points: number; valence: number; warmth: number; hurt: number; soothingRatio: number }
interface CurveData { ok: boolean; days: CurveDay[]; soothingIndex: number; pendingPromises: number }

const fmt = (ts: number) => `${new Date(ts).getMonth() + 1}/${new Date(ts).getDate()}`
const x = (i: number, n: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100)

function polyline(days: CurveDay[], pick: (d: CurveDay) => number, lo: number, hi: number) {
  if (!days.length) return ''
  const span = hi - lo || 1
  return days.map((d, i) => `${x(i, days.length).toFixed(1)},${(100 - ((pick(d) - lo) / span) * 100).toFixed(1)}`).join(' ')
}

const axisLabels = (days: CurveDay[]) => {
  const step = Math.max(1, Math.ceil(days.length / 6))
  return days.filter((_, i) => i % step === 0).map(d => fmt(d.ts))
}

export default function SoulCurves({ sessionId }: { sessionId: string }) {
  const curve = useSWR(
    ['emotion-curve', sessionId],
    () => fetch(`/api/emotion/curve?sessionId=${encodeURIComponent(sessionId || '')}&days=14`).then(r => r.json()) as Promise<CurveData>,
    { refreshInterval: 60000 },
  )
  const days = curve.data?.days || []
  return <>
    <Block title="灵魂曲线" hint="这段时间她的情绪走向（愉悦度、温暖、伤害）。来自每轮互动的情绪潮汐记录。">
      <LoadState error={curve.error} loading={curve.isLoading} retry={() => curve.mutate()} />
      {days.length ? (
        <div className="curves-wrap" role="img" aria-label="灵魂曲线图：愉悦度、温暖、伤害随日期变化">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="curves-svg">
            <polyline fill="none" stroke="var(--pi-accent, #7aa2ff)" strokeWidth="1.2" points={polyline(days, d => d.valence, -1, 1)} />
            <polyline fill="none" stroke="var(--pi-ok, #62c07a)" strokeWidth="1" strokeDasharray="2 1.5" points={polyline(days, d => d.warmth, 0, 1)} />
            <polyline fill="none" stroke="var(--pi-warning, #d08a4a)" strokeWidth="1" strokeDasharray="1.5 1.5" points={polyline(days, d => d.hurt, 0, 1)} />
          </svg>
          <div className="curves-x">{axisLabels(days).map((t, i) => <span key={i}>{t}</span>)}</div>
          <div className="curves-legend">
            <span style={{ color: 'var(--pi-accent, #7aa2ff)' }}>愉悦度</span>
            <span style={{ color: 'var(--pi-ok, #62c07a)' }}>温暖残留</span>
            <span style={{ color: 'var(--pi-warning, #d08a4a)' }}>伤害残留</span>
          </div>
        </div>
      ) : <p className="soul-hint">还没有潮汐记录。对话几天后这里自然长出曲线。</p>}
    </Block>
    <Block title="讨好曲线（安抚密度）" hint="她被要求软语安抚的频率：高=关系在缓和期，低=她在正常做伙伴。不是罪证，是校准仪。">
      {curve.data ? (
        <>
          <div className="curves-wrap" role="img" aria-label="讨好曲线图：安抚密度随日期变化">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="curves-svg">
              {days.map((d, i) => {
                const h = d.soothingRatio * 90
                return <rect key={d.ts} x={x(i, days.length) - 1.4} y={100 - h} width="2.8" height={h}
                  fill="var(--pi-warning, #d08a4a)" opacity="0.75" />
              })}
            </svg>
            <div className="curves-x">{axisLabels(days).map((t, i) => <span key={i}>{t}</span>)}</div>
          </div>
          <p className="soul-hint">
            观测期 soothing 指数 {(curve.data.soothingIndex * 100).toFixed(0)}%；账上还有 <strong>{curve.data.pendingPromises}</strong> 条她说的"下次给你"没兑现。
            承诺是最廉价的讨好方式，账本会追着要（见工作台通知）。
          </p>
        </>
      ) : <p className="soul-hint">正在读取潮汐记录…</p>}
    </Block>
  </>
}
