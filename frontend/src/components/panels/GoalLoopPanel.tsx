import { useState } from 'react'
import useSWR from 'swr'
import { GoalLoopApi, type LoopGoal, type GoalInsight } from '../../api'
import { toast } from '../shell/Toast'
import { CHOICE_EVENT } from '../../lib/choice-reply.mjs'
import { Plus, RefreshCw, Check, Trash2, Target, X } from 'lucide-react'

/**
 * 长期目标（2026-11-23，用户反馈「空间黏性不够」，学 Google Stitch Loop）
 *
 * 首页常驻：你设 1–3 个长期目标，小语每天围绕每个目标跑一轮，
 * 给出「现在的问题 + 依据 + 2–3 个方案」的洞察卡。点一个方案 = 让小语在对话里去做，
 * 同时记一条进展，下一轮她会接着往下想。
 */
const CONF_TEXT = { high: '把握大', medium: '有依据', low: '待验证' } as const

// 刚建的目标服务端在后台跑第一轮：这段时间轮询，等洞察出来
const warmingUp = (g: LoopGoal) => g.status === 'active' && !g.lastRunAt && Date.now() - Date.parse(g.createdAt) < 3 * 60_000

function sinceText(iso: string) {
  if (!iso) return '还没跑过'
  const d = new Date(iso), now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === now.toDateString() ? `今天 ${hm} 想过` : `${d.getMonth() + 1}/${d.getDate()} 想过`
}

export default function GoalLoopPanel() {
  const { data, mutate } = useSWR('goal-loop', () => GoalLoopApi.list(), {
    revalidateOnFocus: true,
    dedupingInterval: 30_000,
    refreshInterval: (d) => (d?.goals?.some(warmingUp) ? 5_000 : 0),
  })
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [busyInsight, setBusyInsight] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  if (!data) return null
  const goals = data.goals || []
  const active = goals.filter((g) => g.status === 'active')
  const canAdd = active.length < (data.maxActive || 3)

  const replace = (g: LoopGoal) => mutate({ ...data, goals: goals.map((x) => (x.id === g.id ? g : x)) }, { revalidate: false })

  const add = async () => {
    const t = title.trim()
    if (!t) return
    try {
      await GoalLoopApi.create(t)
      setTitle(''); setAdding(false)
      toast('目标已记下，小语正在想第一轮方案', 'ok')
      void mutate()
    } catch (e: any) { toast(e?.message || '添加失败', 'error') }
  }

  const run = async (g: LoopGoal) => {
    setRunning((r) => ({ ...r, [g.id]: true }))
    try {
      const r = await GoalLoopApi.run(g.id)
      void replace(r.goal)
      toast(`想好了，新增 ${r.added} 条`, 'ok')
    } catch (e: any) { toast(e?.message || '这轮没跑成，稍后再试', 'error') }
    finally { setRunning((r) => ({ ...r, [g.id]: false })) }
  }

  const resolve = async (g: LoopGoal, ins: GoalInsight, action: 'choose' | 'skip', optionId?: string) => {
    setBusyInsight(ins.id)
    try {
      const r = await GoalLoopApi.resolve(g.id, ins.id, action, optionId)
      void replace(r.goal)
      // 选了方案：交给对话去做（没有会话时 send 会自己新建）
      if (r.prompt) window.dispatchEvent(new CustomEvent(CHOICE_EVENT, { detail: { text: r.prompt } }))
    } catch (e: any) { toast(e?.message || '操作失败', 'error') }
    finally { setBusyInsight('') }
  }

  const finish = async (g: LoopGoal) => {
    try { await GoalLoopApi.update(g.id, { status: 'done' }); toast('目标完成，辛苦了', 'ok'); void mutate() }
    catch (e: any) { toast(e?.message || '操作失败', 'error') }
  }
  const remove = async (g: LoopGoal) => {
    if (!confirm(`删除目标「${g.title}」？它的进展记录也会一起删掉。`)) return
    try { await GoalLoopApi.remove(g.id); void mutate() }
    catch (e: any) { toast(e?.message || '删除失败', 'error') }
  }

  const form = (
    <form className="gl-form" onSubmit={(e) => { e.preventDefault(); void add() }}>
      <input
        autoFocus={adding}
        value={title}
        maxLength={80}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="比如：三个月内把公众号做到 1000 关注"
        aria-label="长期目标"
      />
      <button type="submit" className="btn-primary" disabled={!title.trim()}>设为目标</button>
      {goals.length > 0 && <button type="button" className="gl-icon" onClick={() => setAdding(false)} title="取消"><X className="h-3.5 w-3.5" /></button>}
    </form>
  )

  return (
    <section className="goal-loop" aria-label="长期目标">
      <header className="morning-head">
        <span className="morning-kicker">长期目标</span>
        {goals.length > 0 && <span className="morning-date">{active.length}/{data.maxActive || 3}</span>}
        <span className="morning-actions">
          {goals.length > 0 && canAdd && !adding && (
            <button type="button" onClick={() => setAdding(true)} title="添加目标"><Plus className="h-3.5 w-3.5" strokeWidth={1.8} /></button>
          )}
        </span>
      </header>

      {goals.length === 0 ? (
        <div className="gl-empty">
          <p><Target className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />设一个想长期推进的事，小语每天围绕它想一轮，给你几个能马上动手的方案。</p>
          {form}
        </div>
      ) : (
        <div className="gl-list">
          {adding && form}
          {goals.map((g) => {
            const busy = running[g.id] || warmingUp(g)
            return (
              <article key={g.id} className={`gl-goal ${g.status !== 'active' ? 'is-paused' : ''}`}>
                <div className="gl-goal-head">
                  <h3 title={g.detail || g.title}>{g.title}</h3>
                  <span className="gl-since">{busy ? '小语正在想…' : g.status === 'paused' ? '已暂停' : sinceText(g.lastRunAt)}</span>
                  <span className="morning-actions">
                    <button type="button" onClick={() => run(g)} disabled={busy} title="现在想一轮">
                      <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.8} />
                    </button>
                    <button type="button" onClick={() => finish(g)} title="标记完成"><Check className="h-3.5 w-3.5" strokeWidth={1.8} /></button>
                    <button type="button" onClick={() => remove(g)} title="删除"><Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} /></button>
                  </span>
                </div>
                {g.pending.length > 0 ? (
                  <div className="gl-insights">
                    {/* 首页只亮最新一轮的第一条，其余折叠，别把欢迎区撑成长列表 */}
                    {(expanded[g.id] ? g.pending : [g.pending.find((i) => i.at === g.pending[g.pending.length - 1].at)!]).map((ins) => (
                      <div key={ins.id} className="gl-insight">
                        <p className="gl-problem">
                          <span className={`gl-conf gl-conf-${ins.confidence}`}>{CONF_TEXT[ins.confidence] || '有依据'}</span>
                          {ins.problem}
                        </p>
                        {ins.evidence && <p className="gl-evidence">{ins.evidence}</p>}
                        <div className="gl-options">
                          {ins.options.map((o) => (
                            <button key={o.id} type="button" className="gl-option" disabled={busyInsight === ins.id}
                              title={o.detail || o.label} onClick={() => resolve(g, ins, 'choose', o.id)}>
                              <span>{o.label}</span>
                              {o.detail && <small>{o.detail}</small>}
                            </button>
                          ))}
                          <button type="button" className="gl-skip" disabled={busyInsight === ins.id} onClick={() => resolve(g, ins, 'skip')}>跳过</button>
                        </div>
                      </div>
                    ))}
                    {g.pending.length > 1 && (
                      <button type="button" className="gl-more" onClick={() => setExpanded((x) => ({ ...x, [g.id]: !x[g.id] }))}>
                        {expanded[g.id] ? '收起' : `还有 ${g.pending.length - 1} 条`}
                      </button>
                    )}
                  </div>
                ) : !busy && (
                  <p className="morning-empty">
                    {g.log.length ? `最近：${g.log[g.log.length - 1].text}` : '还没有方案，点右上角让小语现在想一轮。'}
                  </p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
