import useSWR from 'swr'
import { SoulApi } from './api'
import { Block, LoadState, date } from './shared'

const STATUS: Record<string, string> = { done: '完成', blocked: '受阻', failed: '失败' }
const minutes = (ms: number | null | undefined) => ms == null ? '—' : ms < 60000 ? '不到 1 分钟' : `${Math.round(ms / 60000)} 分钟`

// 每晚 0 点：复盘 → 自动执行 → 教训晋升；做梦每 6h。早上一眼看完，等你点的直接给入口。
export default function LastNight() {
  const s = useSWR('soul-last-night', SoulApi.lastNight, { refreshInterval: 60000 })
  const d = s.data
  return <Block title="昨夜" hint="0 点复盘、自动执行、教训晋升和做梦的结果。只读汇总，账以原文件为准。">
    <LoadState error={s.error} loading={s.isLoading} retry={s.mutate} />
    {d && !d.ran && <p className="soul-hint">复盘还没跑过。时间引擎里的每日复盘任务到点后，这里会出结果。</p>}
    {d?.ran && <>
      <dl className="soul-facts">
        <div><dt>复盘于</dt><dd>{date(d.task?.lastRun || d.entry?.at)}</dd></div>
        <div><dt>用时</dt><dd>{minutes(d.task?.durationMs)}</dd></div>
        <div><dt>新承诺</dt><dd>{d.commitments.fresh} 条</dd></div>
        <div><dt>挂账</dt><dd>{d.commitments.pending} 条{d.commitments.stale ? `（${d.commitments.stale} 条超 7 天）` : ''}</dd></div>
      </dl>
      {d.entry?.title && <p className="soul-hint">{d.entry.title}</p>}

      {!!d.entry?.lessons.length && <article className="soul-record soul-night">
        <h4>教训</h4>
        <ul>{d.entry.lessons.map((t, i) => <li key={i}>{t}</li>)}</ul>
      </article>}

      <article className="soul-record soul-night">
        <h4>自动执行{d.entry?.execSummary ? ` · ${d.entry.execSummary.replace(/^本自动执行\s*/, '')}` : ''}</h4>
        {d.entry?.execRows.length
          ? <ul>{d.entry.execRows.map((r, i) => <li key={i}><span className={`soul-night-tag is-${r.status}`}>{STATUS[r.status] || r.status}{r.closed ? ' · 已结清' : ''}</span>{r.text}</li>)}</ul>
          : <p className="soul-hint">昨夜没有可自动执行的修复项。</p>}
      </article>

      <article className="soul-record soul-night">
        <h4>等你点</h4>
        <ul>
          <li>{d.commitments.ask ? <><strong>{d.commitments.ask}</strong> 条请示等你拍板，在台前「待兑现承诺」。</> : '没有等你拍板的请示。'}</li>
          <li>{d.proposals.lesson
            ? <><strong>{d.proposals.lesson}</strong> 条教训跨日复现，提案写进经验库：<a href="#/apps?tab=evolution">去「进化引擎 · 记忆提案」</a></>
            : '没有教训晋升提案。同一教训在两个不同的夜里出现，才会提案。'}</li>
          {d.proposals.lessonItems.map((t, i) => <li key={`l${i}`} className="soul-hint">{t.replace(/^- \[[^\]]*\]\s*/, '')}</li>)}
        </ul>
      </article>

      <article className="soul-record soul-night">
        <h4>做梦</h4>
        <ul>
          <li>失败重试回放：{d.dream.fixTraces ? `${d.dream.fixTraces} 条夜间修复轨迹可比` : '还没有夜间修复轨迹，复盘自动执行跑过之后开始积累'}。</li>
          <li>技能匹配回放：{d.dream.skillEligible ? `${d.dream.skillEligible} 条已核验样本` : <>{d.dream.hint} <a href="#/apps?tab=evolution">去「进化引擎 · 任务证据」核验</a></>}</li>
        </ul>
      </article>
    </>}
  </Block>
}
