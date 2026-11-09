// 「她」的成长与自省（2026-11-10）
// 这一分区回答四个问题，全部来自后台已有的只读接口，前端不加任何写开关：
//   ① 我们处到哪一步了（/api/relationship）
//   ② 这五维长到哪、第几代、有没有提案等着你批（/api/genome/growth）
//   ③ 她做对过什么（/api/praise-ledger，带证据的那种）
//   ④ 踩过的教训复习到哪了（/api/lesson-replay）
// 明显不放在这里的：机制新鲜度 / 退化分 / 定时审计 / 自证与旁路——那是「运行健康」页的活，
// 混进人格页会把"她是谁"讲成"机器状态如何"。
import useSWR from 'swr'
import { Block } from './shared'
import {
  GROWTH_DIMS, GROWTH_DIM_FALLBACK, HerApi, finite, fixed2, praiseRatioText,
} from '../lib/her-api'
import { EmptyLine, FailureLine, LoadingLine, Meter, Tag } from '../components/readout'
import { fmtMsgTime } from '../lib/fmt-time'

/** 本地自然日（复习状态里的 lastInjectedDate 也是本地日，别用 UTC 比）。 */
function localDay(now = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

export default function Growth() {
  const relationship = useSWR('her-relationship', HerApi.relationship, { refreshInterval: 60000, revalidateOnFocus: true })
  const growth = useSWR('her-growth', HerApi.growth, { refreshInterval: 120000, revalidateOnFocus: true })
  const praise = useSWR('her-praise', HerApi.praise, { refreshInterval: 120000, revalidateOnFocus: true })
  const lessons = useSWR('her-lessons', HerApi.lessons, { refreshInterval: 120000, revalidateOnFocus: true })

  return (
    <>
      {/* ── 关系与相处 ── */}
      <Block title="关系与相处" hint="信任涨得慢、掉得快，是设计如此；这里的数字来自真实互动计数，不是自评。">
        {relationship.error ? <FailureLine error={relationship.error} onRetry={() => void relationship.mutate()} />
          : !relationship.data ? <LoadingLine />
            : (() => {
              const rel = relationship.data
              const trust = finite(rel.trust)
              const intimacy = finite(rel.intimacy)
              return (
                <>
                  <p className="soul-self-line">
                    信任 <strong>{fixed2(trust)}</strong> · 亲密 <strong>{fixed2(intimacy)}</strong> · {rel.stage?.name || '关系初建'}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Meter name="信任" value={trust} tone="info" readout={fixed2(trust)} />
                    <Meter name="亲密" value={intimacy} tone="info" readout={fixed2(intimacy)} />
                  </div>
                  <dl className="soul-facts">
                    <div><dt>关系阶段</dt><dd>{rel.stage?.name || '关系初建'}</dd></div>
                    <div><dt>已互动</dt><dd>{finite(rel.interactions)} 次</dd></div>
                    <div><dt>认识于</dt><dd>{rel.firstSeen ? fmtMsgTime(rel.firstSeen) : '未记录'}</dd></div>
                    <div><dt>最近一次</dt><dd>{rel.lastAt ? fmtMsgTime(rel.lastAt) : '未记录'}</dd></div>
                  </dl>
                  <p className="soul-hint">最近备注</p>
                  {rel.notes?.length ? (
                    <ul className="space-y-1">
                      {rel.notes.slice(-5).reverse().map((note, index) => (
                        <li key={`${index}-${note}`} className="text-xs text-pi-dim">{note}</li>
                      ))}
                    </ul>
                  ) : <EmptyLine>还没有备注：互动记上几句，这里才有可回溯的来处。</EmptyLine>}
                </>
              )
            })()}
      </Block>

      {/* ── 成长与世代 ── */}
      <Block title="成长与世代" hint="五维来自真实信号（已聊次数 / 纠正记忆 / 交付门 / 值班日志）；满级只会生成提案，不会自动换代。">
        {growth.error ? <FailureLine error={growth.error} onRetry={() => void growth.mutate()} />
          : !growth.data ? <LoadingLine />
            : (() => {
              const data = growth.data
              const dims = data.dims || {}
              const measured = data.measured || {}
              const labels = { ...GROWTH_DIM_FALLBACK, ...(data.labels || {}) }
              return (
                <>
                  <p className="soul-self-line">
                    第 <strong>{finite(data.generation)}</strong> 代 · 已归档 {data.generations?.length || 0} 代
                    {data.hasPending ? ' · 有一份换代提案等你批' : ''}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {GROWTH_DIMS.map(dim => {
                      const current = finite(dims[dim])
                      const live = Number.isFinite(Number(measured[dim])) ? Number(measured[dim]) : null
                      // 漂移为 0 时不写「（+0.00）」：数字重复一遍只是噪声
                      const drift = live == null ? ''
                        : Math.abs(live - current) < 0.005 ? `实测 ${fixed2(live)}`
                          : `实测 ${fixed2(live)}（${live - current > 0 ? '+' : ''}${(live - current).toFixed(2)}）`
                      return <Meter key={dim} name={labels[dim] || dim} value={current} tone="info" hint={drift} readout={fixed2(current)} />
                    })}
                  </div>
                  {!!data.skipped?.length && (
                    <p className="soul-hint">未参与计算：{data.skipped.slice(0, 3).map(text => String(text).replace(/^（跳过）/, '')).join('；')}</p>
                  )}
                  {data.hasPending && data.pending ? (
                    <article className="soul-record">
                      <h4>换代提案 · 第 {finite(data.pending.fromGeneration)} 代 → 第 {finite(data.pending.toGeneration)} 代</h4>
                      <p>{data.pending.reason || '五维满级，提案待批'}</p>
                      <p className="soul-hint">
                        {data.pending.createdAt ? `生成于 ${fmtMsgTime(data.pending.createdAt)} · ` : ''}
                        批准与拒绝都要你点头，界面只显示状态，不代你决定。
                      </p>
                      <div className="soul-actions"><a className="btn-tool" href="#/soul?s=genes">去基因页处理</a></div>
                    </article>
                  ) : <EmptyLine>暂无待批的换代提案。</EmptyLine>}
                  {!!data.generations?.length && (
                    <ul className="space-y-1">
                      {data.generations.slice(-5).reverse().map(gen => (
                        <li key={`${gen.gen}-${gen.at}`} className="text-xs text-pi-dim">
                          第 {finite(gen.gen)} 代 · {gen.at ? fmtMsgTime(gen.at) : '时间未记录'}
                          {gen.reason ? ` · ${gen.reason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
            })()}
      </Block>

      {/* ── 做对过的事 ── */}
      <Block title="做对过的事" hint="每条都必须带证据（哪次成功/哪个信号/你哪句话）；没有证据的夸奖不进这个账本。">
        {praise.error ? <FailureLine error={praise.error} onRetry={() => void praise.mutate()} />
          : !praise.data ? <LoadingLine />
            : (() => {
              const data = praise.data
              const stats = data.stats
              const top = data.top || []
              const recent = data.recent || []
              return (
                <>
                  <p className="soul-self-line">
                    账本 <strong>{finite(data.total)}</strong> 条 · 近 {finite(stats?.windowDays, 7)} 天：{praiseRatioText(stats)}
                  </p>
                  {stats?.imbalanced && (
                    <p className="soul-notice" role="status">
                      负向多于正向：这段时间"被指出的问题"比"做对的事"多。这个比例只报数，不自动改行为。
                    </p>
                  )}
                  {top.length ? (
                    <>
                      <p className="soul-hint">最站得住的 5 条</p>
                      <ul className="space-y-2">
                        {top.map((entry, index) => (
                          <li key={entry.id || index} className="text-xs">
                            <div className="flex items-start gap-2">
                              <Tag tone="ok">×{finite(entry.weight, 1)}</Tag>
                              <div className="min-w-0">
                                <p className="text-pi-text">{entry.what}</p>
                                {entry.scene && <p className="text-pi-dim2">场景：{entry.scene}</p>}
                                {entry.evidence && <p className="text-pi-dim">证据：{entry.evidence}</p>}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : <EmptyLine>还没有记下做对的事：等一条带证据的正向记录。</EmptyLine>}
                  {recent.length > 0 && (
                    <details className="soul-details">
                      <summary>最近入账（{recent.length} 条）</summary>
                      <ul className="space-y-1">
                        {recent.slice(0, 8).map((entry, index) => (
                          <li key={entry.id || index} className="text-xs text-pi-dim">
                            {entry.at ? `${fmtMsgTime(entry.at)} · ` : ''}{entry.what}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )
            })()}
      </Block>

      {/* ── 教训复习 ── */}
      <Block title="教训复习" hint="每天最多复习几条，按重要度和上次回看的时间排；昨天念过的今天不会连着念。">
        {lessons.error ? <FailureLine error={lessons.error} onRetry={() => void lessons.mutate()} />
          : !lessons.data ? <LoadingLine />
            : (() => {
              const data = lessons.data
              const due = data.due || []
              const recent = data.recent || []
              const reviewedToday = data.state?.lastInjectedDate === localDay()
              return (
                <>
                  <p className="soul-self-line">
                    <strong>{finite(data.total)}</strong> 条教训 · 已升级 {finite(data.promoted)} 条 · 每天最多复习 {finite(data.maxPerDay, 2)} 条
                  </p>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Tag tone={reviewedToday ? 'ok' : 'neutral'}>{reviewedToday ? '今天已复习' : '今天还没复习'}</Tag>
                    <span className="text-pi-dim">今天该念 {due.length} 条</span>
                  </div>
                  {due.length ? (
                    <ul className="space-y-1.5">
                      {due.map(lesson => (
                        <li key={lesson.id} className="text-xs text-pi-text">
                          {lesson.text}
                          {lesson.topic && <span className="ml-1.5 text-pi-dim2">（{lesson.topic}）</span>}
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyLine>今天没有到期的教训——按间隔排期，还没到该回看的时候。</EmptyLine>}
                  {recent.length > 0 && (
                    <details className="soul-details">
                      <summary>最近复习过（{recent.length} 条）</summary>
                      <ul className="space-y-1">
                        {recent.slice(0, 8).map(lesson => (
                          <li key={lesson.id} className="text-xs text-pi-dim">
                            {lesson.lastReplayed ? `${fmtMsgTime(lesson.lastReplayed)} · ` : ''}
                            {lesson.text}
                            {finite(lesson.replayCount) > 1 ? `（已复习 ${finite(lesson.replayCount)} 次）` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )
            })()}
      </Block>
    </>
  )
}
