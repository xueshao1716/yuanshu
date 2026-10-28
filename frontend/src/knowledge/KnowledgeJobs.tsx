import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { KnowledgeApi, knowledgePolling, knowledgeError, knowledgeReason, type KnowledgeJob } from './api'
import KnowledgeSource from './KnowledgeSource'
import KnowledgeProvenance from './KnowledgeProvenance'
import KnowledgeReview from './KnowledgeReview'
import KnowledgeMethod from './KnowledgeMethod'

const labels: Record<string, string> = { queued: '排队中', collecting: '采集来源', extracting: '提炼中', validating: '核对证据', ready: '等待写入', blocked: '等待条件', review_required: '待核查', retry_wait: '等待重试', committed: '已入库', cancelled: '已取消', skipped: '无可用资料', failed: '失败', paused: '已暂停', resolved: '已由补证解决' }
// 2026-10-28：用户说「处理完的是不是可以折叠下了，全看的那个」——926 条已入库一次铺满屏。
// 这些状态算"处理完"，默认折叠；失败/待核查/等待重试仍要摊开。
const FINISHED_STATES = new Set(['committed', 'cancelled', 'skipped', 'resolved'])
const stateOf = (job: { state?: string; displayState?: string }) => String(job.displayState || job.state || '')
const isFinished = (job: { state?: string; displayState?: string }) => FINISHED_STATES.has(stateOf(job))
const date = (n?: number) => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '暂无'
const knowledgeSelection = () => { const value=new URLSearchParams(location.hash.split('?')[1]||'').get('knowledge'); return value&&/^[a-f0-9]{64}$/.test(value)?value:null }

// 2026-10-28：筛选档位。用户「要加他们的内容，我现在看不到，只能看到成功了吗」——
// 除了筛选，还得能直接看到每条的内容，所以把详情搬到行内展开。
const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '要处理的' },
  { key: 'review_required', label: '待核查' },
  { key: 'failed', label: '失败' },
  { key: 'committed', label: '已入库' },
] as const
type FilterKey = typeof FILTERS[number]['key']
const matchesFilter = (job: { state?: string; displayState?: string }, f: FilterKey) => {
  const s = stateOf(job)
  if (f === 'all') return true
  if (f === 'open') return !FINISHED_STATES.has(s) && s !== 'failed'
  return s === f
}

/** 一条记录的内容：从详情接口取，行内展开。 */
function JobDetail({ id, policyRevision, refreshed, busy, act }: {
  id: string; policyRevision?: number; refreshed: () => Promise<unknown>; busy: boolean; act: (job: KnowledgeJob, action: string) => void
}) {
  const detail = useSWR(['knowledge-job', id], () => KnowledgeApi.job(id), knowledgePolling)
  const data = detail.data
  if (detail.isLoading) return <div className="py-2 text-[12px] text-pi-dim">正在读取内容…</div>
  if (detail.error) return <div className="py-2 text-[12px] text-pi-text">这条记录读取失败，请刷新重试。</div>
  if (!data) return null
  return <div className="mt-2 space-y-2 rounded-pi-md bg-pi-bg2/50 px-3 py-3 [overflow-wrap:anywhere]" aria-label="知识记录内容">
    {data.event === 'cultivation' && <>
      <p className="text-[12px] text-pi-dim">培养任务输出 · 模型生成的假设，未经独立核验</p>
      <p className="whitespace-pre-wrap text-[13px]">{data.candidate?.text}</p>
      <p className="text-[12px] text-pi-dim">原运行：{data.cultivationProvenance?.runId} · 设计：{data.cultivationProvenance?.designId}</p>
    </>}
    <p className="text-[12px] text-pi-dim">登记于 {date(data.createdAt)} · 状态：{labels[stateOf(data)] || stateOf(data)}</p>
    {data.resolution && <div className="space-y-1 rounded-pi-md bg-pi-bg2 p-3 leading-6 text-[12px]">
      <p>已由补证解决 · {date(data.resolution.at)}</p>
      <p>补证任务标识：{data.resolution.jobId}<br />知识条目标识：{data.resolution.entryId}</p>
      <p className="text-pi-dim">这是历史处理记录，不代表来源当前仍可引用。引用时仍核对来源与授权；下方保留原始核查结果，不会自动批准原结论。</p>
    </div>}
    <p className="text-[12px] text-pi-dim">{data.resolution ? '原记录' : '处理'}阶段：{labels[data.stage] || data.stage}</p>
    {data.relatedJobId && <p className="text-[12px] text-pi-dim">此条为关联补证 · 原任务标识 {String(data.relatedJobId).slice(0, 12)}</p>}
    {data.replacementJobId && <p className="text-[12px] text-pi-dim">后续处理任务标识 {String(data.replacementJobId).slice(0, 12)} · 可在处理记录中查阅。</p>}
    <KnowledgeProvenance value={data.provenance} />
    <ul className="space-y-1 text-[12px]">{(data.sources || []).map((s, i) => <li key={i}>来源：{s.path || s.url || `任务 ${s.runId}`} {s.hash && <span className="text-pi-dim">（版本 {String(s.hash).slice(0, 12)}）</span>}</li>)}</ul>
    {data.validation && <p className="text-[12px]">{data.resolution ? '原核查记录：' : ''}{knowledgeReason(data.validation.reason)}{data.validation.conflicts?.length ? ` 涉及 ${data.validation.conflicts.length} 条现有资料。` : ''}</p>}
    {data.validation?.entry && <blockquote className="whitespace-pre-wrap rounded-pi-md bg-pi-bg2 p-3 leading-6 text-[13px]">{data.validation.entry.text}</blockquote>}
    <KnowledgeMethod value={data.validation?.entry} />
    {data.state === 'review_required' && !data.resolution && <p className="text-[12px] text-pi-dim">先核查原始资料；可以在下方为这项任务补充证据。补证保留原任务记录，不会自动批准结论。</p>}
    <KnowledgeReview key={`${data.id}:${data.revision}`} job={data} policyRevision={policyRevision} refreshed={refreshed} />
    {policyRevision && !detail.error && !data.resolution && ['review_required','blocked','committed'].includes(data.state) && <KnowledgeSource key={data.id} parent={data} revision={policyRevision} refreshed={refreshed} />}
    <div className="flex flex-wrap gap-2">
      {data.event !== 'cultivation' && !data.resolution && !['committed','cancelled','skipped','failed','paused'].includes(data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(data, 'pause')}>暂停任务</button>}
      {data.event !== 'cultivation' && !data.resolution && data.state === 'paused' && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(data, 'resume')}>继续任务</button>}
      {data.event !== 'cultivation' && !data.resolution && ['blocked','retry_wait','failed'].includes(data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(data, 'retry')}>重试任务</button>}
      {!data.resolution && !['committed','cancelled','skipped','failed'].includes(data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(data, 'cancel')}>取消任务</button>}
    </div>
  </div>
}

export default function KnowledgeJobs({ refreshed, policyRevision }: { refreshed: () => Promise<unknown>; policyRevision?: number }) {
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(knowledgeSelection)
  const [filter, setFilter] = useState<FilterKey>('all')
  useEffect(()=>{const sync=()=>setSelected(knowledgeSelection());window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync)},[])
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const list = useSWR(['knowledge-jobs', offset], () => KnowledgeApi.jobs(offset), knowledgePolling)
  const refreshQueue = async () => {
    const results = await Promise.allSettled([list.mutate(), refreshed()])
    if (results.some(r => r.status === 'rejected')) setError('队列刷新失败，请稍后再试。')
  }
  const act = async (job: KnowledgeJob, action: string) => {
    if (busy) return
    setBusy(true); setError('')
    try { await KnowledgeApi.control(job.id, action, job.revision) } catch (e) { setError(knowledgeError(e)) }
    finally {
      const results = await Promise.allSettled([list.mutate(), refreshed()])
      if (results.some(r => r.status === 'rejected')) setError('操作结果刷新失败，请刷新队列核对，勿重复提交。')
      setBusy(false)
    }
  }
  const items = list.data?.items || []
  const shownRows = items.filter((j) => matchesFilter(j, filter))
  const finished = shownRows.filter((j) => isFinished(j))
  const active = shownRows.filter((j) => !isFinished(j))
  const row = (job: any) => <li key={job.id} className="py-2">
    <button className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 text-left" aria-expanded={selected === job.id} onClick={() => setSelected(selected === job.id ? null : job.id)}>
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{job.title}</span>
      <span className="shrink-0 text-pi-dim">{labels[stateOf(job)] || stateOf(job)}</span>
      <span className="shrink-0 text-[11px] text-pi-dim2">{selected === job.id ? '收起内容' : '看内容'}</span>
    </button>
    {job.reason && <p className="text-[12px] leading-5 text-pi-dim">{job.resolution ? '原记录：' : ''}{knowledgeReason(job.reason)}</p>}
    {job.state === 'retry_wait' && <p className="text-[12px] text-pi-dim">下次尝试：{date(job.nextAttemptAt)}</p>}
    {selected === job.id && <JobDetail id={job.id} policyRevision={policyRevision} refreshed={refreshQueue} busy={busy} act={act} />}
  </li>

  return <section className="border-t border-pi-border-soft pt-4 space-y-3" aria-label="知识任务">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">处理记录{list.data ? ` · ${list.data.total}` : ''}</h4>
      <button className="btn-tool min-h-11 px-3" onClick={() => void refreshQueue()}>刷新队列</button>
    </div>
    <div className="flex flex-wrap gap-2" role="group" aria-label="按状态筛选">
      {FILTERS.map((f) => <button
        key={f.key}
        className={`btn-tool min-h-9 px-3 text-[12px] ${filter === f.key ? '!bg-pi-bg3 font-medium text-pi-text' : 'text-pi-dim'}`}
        aria-pressed={filter === f.key}
        onClick={() => { setFilter(f.key); setSelected(null) }}
      >{f.label}{f.key === 'all' ? '' : ` ${items.filter((j) => matchesFilter(j, f.key)).length}`}</button>)}
    </div>
    {(error || list.error) && <p role="alert">{error || knowledgeError(list.error)}</p>}
    {list.isLoading && <p role="status">正在读取队列…</p>}
    {list.data?.total === 0 && <p className="leading-6 text-pi-dim">暂无知识任务。完成一项工作，或补充一份获准的资料后，后台会在空闲时处理。</p>}
    {shownRows.length === 0 && items.length > 0 && <p className="text-[12px] text-pi-dim">这一页没有符合「{FILTERS.find((f) => f.key === filter)?.label}」的记录。翻页或在上面换一档看看。</p>}
    {active.length > 0 && <ul className="divide-y divide-pi-border-soft">{active.map(row)}</ul>}
    {active.length === 0 && finished.length > 0 && <p className="text-[12px] text-pi-dim">当前没有需要你处理的知识任务。</p>}
    {finished.length > 0 && <details className="border-t border-pi-border-soft pt-2">
      <summary className="cursor-pointer text-[13px] text-pi-text">处理完的 {finished.length} 条<span className="ml-2 text-[11px] text-pi-dim">（已入库/已取消/无可用资料/已补证 · 点开回顾，点单条看内容）</span></summary>
      <ul className="mt-1 divide-y divide-pi-border-soft">{finished.map(row)}</ul>
    </details>}
    {!!list.data?.total && <nav className="flex flex-wrap items-center gap-3" aria-label="知识队列分页">
      <button className="btn-tool min-h-11 px-3" disabled={offset === 0} onClick={() => {setOffset(n => Math.max(0,n - 20)); setSelected(null)}}>上一页</button>
      <span className="tabular-nums text-pi-dim">第 {Math.floor(offset / 20) + 1} / {Math.max(1,Math.ceil(list.data.total / 20))} 页</span>
      <button className="btn-tool min-h-11 px-3" disabled={offset + 20 >= list.data.total} onClick={() => {setOffset(n => n + 20); setSelected(null)}}>下一页</button>
    </nav>}
  </section>
}
