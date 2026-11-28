import { useState } from 'react'
import useSWR from 'swr'
import { Target, Check, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { GoalLoopApi, type LoopGoalDetail, type GoalInsightFull } from '../api'
import EmptyState from '../components/EmptyState'
import PageHeader from '../components/PageHeader'
import SectionHeader from '../components/SectionHeader'
import { toast } from '../components/shell/Toast'
import { CHOICE_EVENT } from '../lib/choice-reply.mjs'

// 目标页（2026-11-29，学 Muse 的「目标」视图）：每个长期目标的完整时间线。
// 首页卡片只亮最新一条待处理洞察；这里能看到每一轮想了什么、你选了哪个方案、跳过了什么。

const STATUS_TEXT = { active: '进行中', paused: '已暂停', done: '已完成' } as const
const INSIGHT_TEXT = { pending: '待处理', chosen: '已选方案', skipped: '已跳过', expired: '已过期' } as const
const CONF_TEXT = { high: '把握大', medium: '有依据', low: '待验证' } as const

function when(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function InsightRow({ ins, busy, onChoose, onSkip }: {
  ins: GoalInsightFull; busy: boolean; onChoose: (optionId: string) => void; onSkip: () => void
}) {
  const picked = ins.options.find((o) => o.id === ins.choice)
  return (
    <li className={`panel space-y-2 ${ins.status === 'pending' ? '' : 'opacity-80'}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-pi-dim">
        <span>{when(ins.at)}</span>
        <span className="px-1.5 py-0.5 rounded-pi-pill border border-pi-border">{INSIGHT_TEXT[ins.status] || ins.status}</span>
        <span>{CONF_TEXT[ins.confidence] || '有依据'}</span>
      </div>
      <p className="text-sm text-pi-text break-words">{ins.problem}</p>
      {ins.evidence && <p className="text-xs text-pi-dim break-words">依据：{ins.evidence}</p>}
      {ins.status === 'chosen' && picked && <p className="text-sm text-pi-success break-words">你选了：{picked.label}</p>}
      {ins.status === 'pending' ? (
        <div className="flex flex-wrap gap-2">
          {ins.options.map((o) => (
            <button key={o.id} type="button" className="btn-primary min-h-11 px-3 text-left" disabled={busy} title={o.detail || o.label} onClick={() => onChoose(o.id)}>{o.label}</button>
          ))}
          <button type="button" className="min-h-11 px-3 text-sm text-pi-dim" disabled={busy} onClick={onSkip}>跳过</button>
        </div>
      ) : (
        <ul className="text-xs text-pi-dim2 space-y-0.5">
          {ins.options.map((o) => <li key={o.id} className="break-words">{o.id === ins.choice ? '✓ ' : '· '}{o.label}</li>)}
        </ul>
      )}
    </li>
  )
}

function GoalBlock({ g, onChanged }: { g: LoopGoalDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState('')
  const act = async (key: string, work: () => Promise<unknown>, okText?: string) => {
    setBusy(key)
    try { await work(); if (okText) toast(okText, 'ok'); onChanged() }
    catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusy('') }
  }
  const resolve = (ins: GoalInsightFull, action: 'choose' | 'skip', optionId?: string) => act(ins.id, async () => {
    const r = await GoalLoopApi.resolve(g.id, ins.id, action, optionId)
    // 选了方案：交给对话去做，和首页一致
    if (r.prompt) window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { text: r.prompt } }))
  })
  const live = g.status !== 'done'
  return (
    <section className="space-y-3" data-slot="goal-block">
      <SectionHeader title={g.title} description={`${STATUS_TEXT[g.status]} · 创建于 ${when(g.createdAt)}${g.lastRunAt ? ` · 最近想过 ${when(g.lastRunAt)}` : ' · 还没跑过'}`} />
      {g.detail && <p className="text-sm text-pi-dim break-words">{g.detail}</p>}
      <div className="flex flex-wrap gap-2">
        {g.status === 'active' && <button type="button" className="min-h-11 px-3 text-sm inline-flex items-center gap-1" disabled={!!busy} onClick={() => act('run', () => GoalLoopApi.run(g.id), '想好了')}><RefreshCw size={14} aria-hidden="true" />现在想一轮</button>}
        {g.status === 'active' && <button type="button" className="min-h-11 px-3 text-sm inline-flex items-center gap-1" disabled={!!busy} onClick={() => act('pause', () => GoalLoopApi.update(g.id, { status: 'paused' }))}><Pause size={14} aria-hidden="true" />暂停</button>}
        {g.status === 'paused' && <button type="button" className="min-h-11 px-3 text-sm inline-flex items-center gap-1" disabled={!!busy} onClick={() => act('resume', () => GoalLoopApi.update(g.id, { status: 'active' }))}><Play size={14} aria-hidden="true" />继续</button>}
        {live && <button type="button" className="min-h-11 px-3 text-sm inline-flex items-center gap-1" disabled={!!busy} onClick={() => act('done', () => GoalLoopApi.update(g.id, { status: 'done' }), '目标完成，辛苦了')}><Check size={14} aria-hidden="true" />标记完成</button>}
        <button type="button" className="min-h-11 px-3 text-sm inline-flex items-center gap-1 text-pi-danger" disabled={!!busy} onClick={() => { if (confirm(`删除目标「${g.title}」？它的全部记录也会删掉。`)) void act('del', () => GoalLoopApi.remove(g.id)) }}><Trash2 size={14} aria-hidden="true" />删除</button>
      </div>
      {g.log.length > 0 && (
        <details open>
          <summary className="text-sm text-pi-text cursor-pointer">进展记录（{g.log.length}）</summary>
          <ul className="mt-2 space-y-1 text-sm text-pi-dim">
            {g.log.map((l, i) => <li key={i} className="break-words">{when(l.at)} · {l.text}</li>)}
          </ul>
        </details>
      )}
      {g.insights.length > 0 ? (
        <ul className="space-y-2">
          {g.insights.map((ins) => (
            <InsightRow key={ins.id} ins={ins} busy={busy === ins.id}
              onChoose={(oid) => void resolve(ins, 'choose', oid)} onSkip={() => void resolve(ins, 'skip')} />
          ))}
        </ul>
      ) : <p className="text-sm text-pi-dim">还没有洞察。</p>}
    </section>
  )
}

export default function Goals() {
  const { data, error, mutate } = useSWR('goal-loop-history', GoalLoopApi.history, { revalidateOnFocus: true, shouldRetryOnError: false })
  const goals = data?.goals || []
  const open = goals.filter((g) => g.status !== 'done')
  const done = goals.filter((g) => g.status === 'done')
  return (
    <div className="page-shell space-y-6">
      <PageHeader title="目标" description="小语每天围绕你的长期目标想一轮。这里能看到每个目标的完整时间线：想了什么、你选了什么、跳过了什么。" />
      {error && <p role="alert" className="text-sm text-pi-danger">读取失败，请刷新重试</p>}
      {data && goals.length === 0 && <EmptyState icon={Target} title="还没有长期目标" hint="在对话首页的「长期目标」卡里设一个，小语就会每天围绕它想一轮。" />}
      {open.map((g) => <GoalBlock key={g.id} g={g} onChanged={() => void mutate()} />)}
      {done.length > 0 && <>
        <SectionHeader title={`已完成（${done.length}）`} />
        {done.map((g) => <GoalBlock key={g.id} g={g} onChanged={() => void mutate()} />)}
      </>}
    </div>
  )
}
