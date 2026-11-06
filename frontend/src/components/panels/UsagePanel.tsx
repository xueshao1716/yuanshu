import useSWR from 'swr'
import { api } from '../../api'

type UsageModel = { model: string; rounds: number; calls: number; input: number; output: number; cacheRead: number; total: number }
type UsageRound = {
  at: string; sessionId: string; runId: string; model: string; engine: string
  input: number; output: number; cacheRead: number; total: number; calls: number; lastCtx: number; totalMs: number
}
type UsageReport = {
  today: string; roundsToday: number; total: number; input: number; output: number
  cacheRead: number; calls: number; models: UsageModel[]; rounds: UsageRound[]
}

const n = (v: number) => (v >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))
const pct = (part: number, all: number) => (all > 0 ? Math.round((part / all) * 100) : 0)
const hhmm = (iso: string) => {
  try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

/**
 * 用量面板（2026-11-06）：每日 token 统计、每轮花在哪、每个模型吃多少。
 * 数据源 GET /api/usage/report（读 记忆/运行时/每轮耗时.jsonl）。
 */
export default function UsagePanel() {
  const { data, error } = useSWR<UsageReport>('usage-report', () => api('/api/usage/report?limit=30'), { refreshInterval: 60000 })
  if (error) return <div className="panel !p-5 text-[13px] text-pi-danger">用量数据读不到（{String((error as any)?.message || '接口报错')}）</div>
  if (!data) return <div className="panel !p-5 text-[13px] text-pi-dim2">正在读取用量…</div>

  const cacheRate = pct(data.cacheRead, data.input)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { k: '今日总量', v: n(data.total), d: `${data.roundsToday} 轮 · ${data.calls} 次模型调用` },
          { k: '输入', v: n(data.input), d: `占总量的 ${pct(data.input, data.total)}%` },
          { k: '输出', v: n(data.output), d: `占 ${pct(data.output, data.total)}%` },
          { k: '缓存命中', v: n(data.cacheRead), d: `输入里 ${cacheRate}% 命中缓存` },
        ].map(x => (
          <div key={x.k} className="panel !p-4">
            <div className="text-[11px] text-pi-dim2">{x.k}</div>
            <div className="text-[20px] font-semibold text-pi-text tabular-nums">{x.v}</div>
            <div className="text-[11px] text-pi-dim2 mt-0.5">{x.d}</div>
          </div>
        ))}
      </div>

      <div className="panel !p-4">
        <div className="text-[13px] font-medium mb-2">每个模型吃了多少</div>
        <div className="space-y-1.5">
          {data.models.map(m => (
            <div key={m.model} className="flex items-center gap-2 text-[12px]">
              <span className="font-mono text-[11px] text-pi-dim2 w-[190px] shrink-0 truncate">{m.model || '(未知)'}</span>
              <span className="tabular-nums w-[70px] text-right">{n(m.total)}</span>
              <span className="text-pi-dim2 w-[86px] text-right">{m.rounds} 轮 / {m.calls} 次</span>
              <div className="flex-1 h-1.5 rounded-full bg-pi-bg3 overflow-hidden">
                <div className="h-full bg-pi-accent" style={{ width: `${pct(m.total, data.total)}%` }} />
              </div>
              <span className="tabular-nums w-[38px] text-right text-pi-dim2">{pct(m.total, data.total)}%</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel !p-4 overflow-x-auto">
        <div className="text-[13px] font-medium mb-2">每轮花在哪（最近 {data.rounds.length} 轮）</div>
        <table className="w-full text-[11.5px] tabular-nums">
          <thead className="text-pi-dim2">
            <tr className="text-left">
              <th className="py-1 font-normal">时间</th>
              <th className="py-1 font-normal">模型</th>
              <th className="py-1 font-normal text-right">输入</th>
              <th className="py-1 font-normal text-right">输出</th>
              <th className="py-1 font-normal text-right">缓存</th>
              <th className="py-1 font-normal text-right">合计</th>
              <th className="py-1 font-normal text-right">调用</th>
              <th className="py-1 font-normal text-right">末次上下文</th>
              <th className="py-1 font-normal text-right">耗时</th>
              <th className="py-1 font-normal">会话</th>
            </tr>
          </thead>
          <tbody>
            {data.rounds.map((r, i) => (
              <tr key={`${r.runId}-${i}`} className="border-t border-pi-border-soft">
                <td className="py-1">{hhmm(r.at)}</td>
                <td className="py-1 font-mono text-[10.5px] truncate max-w-[160px]">{r.model || '(未知)'}</td>
                <td className="py-1 text-right">{n(r.input)}</td>
                <td className="py-1 text-right">{r.output}</td>
                <td className="py-1 text-right text-pi-dim2">{r.cacheRead ? n(r.cacheRead) : '—'}</td>
                <td className="py-1 text-right font-medium">{n(r.total)}</td>
                <td className="py-1 text-right">{r.calls}</td>
                <td className="py-1 text-right text-pi-dim2">{r.lastCtx ? n(r.lastCtx) : '—'}</td>
                <td className="py-1 text-right text-pi-dim2">{Math.round(r.totalMs / 1000)}s</td>
                <td className="py-1 font-mono text-[10.5px] text-pi-dim2">{r.sessionId}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-pi-dim2 mt-2">
          「输入」是这一轮所有模型调用的输入 token 之和：工具循环里每多调一次，上下文就要重发一次——这就是单轮动辄几万的原因。
        </p>
      </div>
    </div>
  )
}
