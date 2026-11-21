// GenUI-lite（08-24）：模型在回答里输出 ```dsh-ui 围栏 + JSON spec → 渲染成结构化组件
// 组件词汇对标 dsh-genui（精简版）：text/row/col/grid/card/stat/badge/list/table/keyvalue/callout/steps/divider/progress/timeline
// choice（11-17，学 A2UI）：唯一能点的组件——选项/自己填/跳过，点了当作你的下一句话发给小语
import { useState } from 'react'
import { normalizeChoice, choiceReplyText, CHOICE_EVENT, type ChoiceSpec } from '../lib/choice-reply.mjs'
type Spec = any

function ChoiceCard({ c }: { c: ChoiceSpec }) {
  const [answered, setAnswered] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const reply = (a: { label?: string; custom?: string; skip?: boolean }, shown: string) => {
    const text = choiceReplyText({ question: c.question, ...a })
    if (!text || answered) return
    setAnswered(shown)
    window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { text } }))
  }
  // 全局 button 是 nowrap（premium.css），选项按钮里的长文字不换行会把卡片撑出手机屏幕
  return (
    <div className="min-w-0 rounded-pi-lg border border-pi-accent/25 bg-pi-accent/5 p-3 space-y-2">
      <div className="text-[13px] font-semibold text-pi-text break-words">{c.question}</div>
      <div className="flex flex-col gap-1.5">
        {c.options.map((o, i) => (
          <button key={i} type="button" disabled={!!answered} onClick={() => reply({ label: o.label }, o.label)}
            className={`w-full min-w-0 text-left whitespace-normal break-words rounded-pi-md border px-3 py-2 transition-colors disabled:cursor-default ${answered === o.label ? 'border-pi-accent bg-pi-accent/15' : 'border-pi-border-soft bg-white/[0.03] enabled:hover:border-pi-accent/50 enabled:hover:bg-pi-accent/8'} ${answered && answered !== o.label ? 'opacity-45' : ''}`}>
            <span className="text-[13px] text-pi-text">{o.label}</span>
            {o.desc && <span className="block text-[11px] text-pi-dim mt-0.5">{o.desc}</span>}
          </button>
        ))}
      </div>
      {answered ? (
        <div className="text-[11px] text-pi-dim">已回答：{answered}</div>
      ) : (c.custom || c.skip) && (
        <div className="flex items-center gap-1.5">
          {c.custom && (
            <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="自己填…" aria-label="自己填答案"
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && draft.trim()) reply({ custom: draft }, draft.trim()) }}
              className="flex-1 min-w-0 rounded-pi-md border border-pi-border-soft bg-white/[0.03] px-2.5 py-1.5 text-[13px] text-pi-text outline-none focus:border-pi-accent/60" />
          )}
          {c.custom && <button type="button" disabled={!draft.trim()} onClick={() => reply({ custom: draft }, draft.trim())} className="btn-primary px-2.5 py-1.5 text-[12px] rounded-pi-md disabled:opacity-40">发送</button>}
          {c.skip && <button type="button" onClick={() => reply({ skip: true }, '跳过')} className="ml-auto px-2.5 py-1.5 text-[12px] text-pi-dim hover:text-pi-text rounded-pi-md">跳过</button>}
        </div>
      )}
    </div>
  )
}

const SIZES: Record<string, string> = { h1: 'text-[17px] font-extrabold', h2: 'text-[15px] font-bold', h3: 'text-[15px] font-semibold', body: 'text-[13px]', muted: 'text-[13px] text-pi-dim', caption: 'text-[11px] text-pi-dim2' }

function Node({ n, k }: { n: Spec; k?: string }) {
  if (!n || typeof n !== 'object') return typeof n === 'string' ? <span key={k}>{n}</span> : null
  switch (n.type) {
    case 'text': {
      const cls = `block ${SIZES[n.size] || SIZES.body} ${n.center ? 'text-center' : ''}`
      return <span key={k} className={cls}>{n.content}</span>
    }
    case 'row': return <div key={k} className={`flex ${n.wrap ? 'flex-wrap' : ''} items-start`} style={{ gap: n.gap ?? 8 }}>{(n.items || []).map((x: Spec, i: number) => <Node key={i} n={x} />)}</div>
    case 'col': return <div key={k} className="flex flex-col" style={{ gap: n.gap ?? 8 }}>{(n.items || []).map((x: Spec, i: number) => <Node key={i} n={x} />)}</div>
    case 'grid': return <div key={k} className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(n.cols || 2, 4)}, minmax(0,1fr))`, gap: n.gap ?? 10 }}>{(n.items || []).map((x: Spec, i: number) => <Node key={i} n={x} />)}</div>
    case 'card': return (
      <div key={k} className="rounded-pi-lg border border-pi-border-soft bg-white/[0.03] p-3">
        {n.title && <div className="text-[13px] font-semibold text-pi-text mb-1.5">{n.title}</div>}
        <div className="space-y-1.5">{(n.items || []).map((x: Spec, i: number) => <Node key={i} n={x} />)}</div>
      </div>
    )
    case 'stat': return (
      <div key={k} className="rounded-pi-lg border border-pi-border-hi bg-white/[0.03] px-3 py-2">
        <div className="text-[11px] text-pi-dim2">{n.label}</div>
        <div className={`text-[17px] font-bold font-mono tabular-nums mt-0.5 ${String(n.delta || '').startsWith('-') ? 'text-pi-red' : String(n.delta || '').startsWith('+') ? 'text-emerald-400' : 'text-pi-text'}`}>
          {n.value}{n.delta && <span className="text-[11px] ml-1 opacity-80">{n.delta}</span>}
        </div>
      </div>
    )
    case 'badge': return <span key={k} className="inline-flex items-center px-2 py-0.5 rounded-pi-sm text-[11px] bg-pi-accent/12 border border-pi-accent/25 text-pi-accent">{n.content || n.text}</span>
    case 'list': return (
      <ul key={k} className="space-y-1 text-[13px] text-pi-text/90">
        {(n.items || []).map((x: any, i: number) => {
          const txt = typeof x === 'string' ? x : x?.content || ''
          return <li key={i} className="flex gap-1.5"><span className="text-pi-accent2 select-none">•</span><span>{txt}</span></li>
        })}
      </ul>
    )
    case 'table': return (
      <div key={k} className="overflow-x-auto my-1"><table className="w-full border-collapse text-[13px]">
        <thead>{(n.columns || []).map((c: string, i: number) => <th key={i} className="border border-pi-border px-2.5 py-1.5 bg-pi-bg3/60 font-semibold text-left">{c}</th>)}</thead>
        <tbody>{(n.rows || []).map((r: any[], i: number) => <tr key={i} className="hover:bg-white/[0.03]">{r.map((c, j) => <td key={j} className="border border-pi-border px-2.5 py-1.5">{String(c)}</td>)}</tr>)}</tbody>
      </table></div>
    )
    case 'keyvalue': return (
      <div key={k} className="space-y-1">{Object.entries(n.data || {}).map(([kk, v]) => (
        <div key={kk} className="flex gap-2 text-[13px]"><span className="text-pi-dim w-28 flex-shrink-0 truncate">{kk}</span><span className="text-pi-text font-mono break-all">{String(v)}</span></div>
      ))}</div>
    )
    case 'callout': {
      const tones: Record<string, string> = { info: 'border-sky-500/25 bg-sky-500/8 text-sky-300/90', warn: 'border-amber-500/25 bg-amber-500/8 text-amber-300/90', error: 'border-pi-red/30 bg-pi-red/8 text-pi-red', ok: 'border-emerald-500/25 bg-emerald-500/8 text-emerald-300/90' }
      const t = tones[n.tone || 'info'] || tones.info
      return <div key={k} className={`rounded-pi-md border px-3 py-2 text-[13px] ${t}`}>{n.icon ? `${n.icon} ` : ''}{n.content}</div>
    }
    case 'steps': return (
      <ol key={k} className="space-y-0">
        {(n.items || []).map((x: any, i: number) => (
          <li key={i} className="flex gap-2.5 relative">
            <div className="flex flex-col items-center flex-shrink-0">
              <span className="w-5 h-5 rounded-full bg-pi-accent/15 text-pi-accent text-[10px] font-bold flex items-center justify-center z-10">{i + 1}</span>
              {i < (n.items.length - 1) && <span className="flex-1 w-px bg-pi-border absolute top-5 bottom-[-6px]" />}
            </div>
            <span className="text-[13px] text-pi-text/90 pb-2.5">{typeof x === 'string' ? x : x?.content}</span>
          </li>
        ))}
      </ol>
    )
    case 'divider': return <hr key={k} className="my-2 border-0 border-t border-pi-border-soft" />
    case 'progress': return (
      <div key={k}>
        {n.label && <div className="flex justify-between text-[11px] text-pi-dim mb-1"><span>{n.label}</span><span className="font-mono">{n.value != null ? `${Math.round(n.value)}%` : ''}</span></div>}
        <div className="h-1.5 rounded-full bg-white/[0.06] overflow-hidden"><div className="h-full rounded-full btn-grad" style={{ width: `${Math.min(Math.max(n.value || 0, 0), 100)}%` }} /></div>
      </div>
    )
    case 'timeline': return (
      <div key={k} className="space-y-2.5">
        {(n.items || []).map((x: any, i: number) => (
          <div key={i} className="flex gap-2.5">
            <span className="text-[11px] font-mono text-pi-accent2 w-14 flex-shrink-0 pt-0.5">{x.time || ''}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-pi-accent mt-1.5 flex-shrink-0" />
            <span className="text-[13px] text-pi-text/85">{typeof x === 'string' ? x : x?.content}</span>
          </div>
        ))}
      </div>
    )
    case 'choice': {
      const c = normalizeChoice(n)
      return c ? <ChoiceCard key={k} c={c} /> : null
    }
    default: return null
  }
}

export default function GenUIBlock({ raw }: { raw: string }) {
  let err: string | null = null
  let spec: Spec = null
  try { spec = JSON.parse(raw) } catch (e: any) { err = e?.message || 'JSON 解析失败' }
  const items = spec?.items ?? (spec && typeof spec === 'object' && (spec.type || spec.title !== undefined) ? [spec] : null)
  if (!spec || !items || err) {
    // 解析失败 → 回退普通代码块展示，不吞内容
    return (
      <pre className="code-block bg-pi-bg1 border border-pi-border rounded-lg p-3 overflow-x-auto my-2 text-[12px] text-pi-dim">
        {`[genui spec 无效${err ? '：' + err : ''}]\n` + raw.slice(0, 2000)}
      </pre>
    )
  }
  return (
    <div className="my-2 rounded-pi-lg glass panel-glass p-3 space-y-2.5 max-w-full overflow-x-hidden">
      {spec.title && <div className="text-[13px] font-bold text-pi-text pb-1.5 mb-1 border-b border-pi-border-soft flex items-center gap-2"><span className="w-1 h-3.5 rounded-full btn-grad inline-block" />{spec.title}</div>}
      {items.map((x: Spec, i: number) => <Node key={i} n={x} />)}
    </div>
  )
}
