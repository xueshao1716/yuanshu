import { useState } from 'react'
import useSWR from 'swr'
import { KnowledgeApi, knowledgePolling, knowledgeError, knowledgeReason, type KnowledgeJob } from './api'
import KnowledgeSource from './KnowledgeSource'
import KnowledgeProvenance from './KnowledgeProvenance'
import KnowledgeReview from './KnowledgeReview'
import KnowledgeMethod from './KnowledgeMethod'

const labels: Record<string, string> = { queued: '排队中', collecting: '采集来源', extracting: '提炼中', validating: '核对证据', ready: '等待写入', blocked: '等待条件', review_required: '待核查', retry_wait: '等待重试', committed: '已入库', cancelled: '已取消', skipped: '无可用资料', failed: '失败', paused: '已暂停', resolved: '已由补证解决' }
const date = (n?: number) => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '暂无'
export default function KnowledgeJobs({ refreshed, policyRevision }: { refreshed: () => Promise<unknown>; policyRevision?: number }) {
  const [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const list = useSWR(['knowledge-jobs', offset], () => KnowledgeApi.jobs(offset), knowledgePolling)
  const detail = useSWR(selected ? ['knowledge-job', selected] : null, () => KnowledgeApi.job(selected!), knowledgePolling)
  const refreshQueue = async () => {
    const results = await Promise.allSettled([list.mutate(), detail.mutate(), refreshed()])
    if (results.some(r => r.status === 'rejected')) setError('队列刷新失败，请稍后再试。')
  }
  const act = async (job: KnowledgeJob, action: string) => {
    if (busy) return
    setBusy(true); setError('')
    try { await KnowledgeApi.control(job.id, action, job.revision) } catch (e) { setError(knowledgeError(e)) }
    finally {
      const results = await Promise.allSettled([list.mutate(), detail.mutate(), refreshed()])
      if (results.some(r => r.status === 'rejected')) setError('操作结果刷新失败，请刷新队列核对，勿重复提交。')
      setBusy(false)
    }
  }
  return <section className="border-t border-pi-border-soft pt-4 space-y-3" aria-label="知识任务">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">处理记录{list.data ? ` · ${list.data.total}` : ''}</h4><button className="btn-tool min-h-11 px-3" onClick={() => void refreshQueue()}>刷新队列</button></div>
    {(error || list.error || detail.error) && <p role="alert">{error || knowledgeError(list.error || detail.error)}</p>}
    {list.isLoading && <p role="status">正在读取队列…</p>}
    {list.data?.total === 0 && <p className="text-pi-dim leading-6">暂无知识任务。完成一项工作，或补充一份获准的资料后，后台会在空闲时处理。</p>}
    <ul className="divide-y divide-pi-border-soft">{list.data?.items.map(job => <li key={job.id} className="py-2">
      <button className="w-full min-h-11 text-left flex flex-wrap items-center justify-between gap-2" aria-expanded={selected === job.id} onClick={() => setSelected(selected === job.id ? null : job.id)}>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{job.title}</span><span className="text-pi-dim shrink-0">{labels[job.displayState || job.state] || job.state}</span>
      </button>
      {job.reason && <p className="text-pi-dim text-[12px] leading-5">{job.resolution ? '原记录：' : ''}{knowledgeReason(job.reason)}</p>}
      {job.state === 'retry_wait' && <p className="text-pi-dim text-[12px]">下次尝试：{date(job.nextAttemptAt)}</p>}
      {selected === job.id && <div className="py-3 space-y-3 [overflow-wrap:anywhere]">
        {detail.isLoading && <p role="status">正在读取来源…</p>}
        {detail.data?.id === job.id && <>
          <p className="text-pi-dim">登记于 {date(detail.data.createdAt)} · 状态：{labels[detail.data.displayState || detail.data.state] || detail.data.state}</p>
          {detail.data.resolution && <div className="bg-pi-bg2 p-3 rounded-pi-md space-y-1 leading-6">
            <p>已由补证解决 · {date(detail.data.resolution.at)}</p>
            <p>补证任务标识：{detail.data.resolution.jobId}<br />知识条目标识：{detail.data.resolution.entryId}</p>
            <p className="text-pi-dim">这是历史处理记录，不代表来源当前仍可引用。引用时仍核对来源与授权；下方保留原始核查结果，不会自动批准原结论。</p>
          </div>}
          <p className="text-pi-dim">{detail.data.resolution ? '原记录' : '处理'}阶段：{labels[detail.data.stage] || detail.data.stage}</p>
          {detail.data.relatedJobId && <p className="text-pi-dim">此条为关联补证 · 原任务标识 {detail.data.relatedJobId.slice(0, 12)}</p>}
          {detail.data.replacementJobId && <p className="text-pi-dim">后续处理任务标识 {detail.data.replacementJobId.slice(0, 12)} · 可在处理记录中查阅。</p>}
          <KnowledgeProvenance value={detail.data.provenance} />
          <ul className="space-y-1">{detail.data.sources.map((s, i) => <li key={i}>来源：{s.path || s.url || `任务 ${s.runId}`} {s.hash && <span className="text-pi-dim">（版本 {s.hash.slice(0, 12)}）</span>}</li>)}</ul>
          {detail.data.validation && <p>{detail.data.resolution ? '原核查记录：' : ''}{knowledgeReason(detail.data.validation.reason)}{detail.data.validation.conflicts?.length ? ` 涉及 ${detail.data.validation.conflicts.length} 条现有资料。` : ''}</p>}
          {detail.data.validation?.entry && <blockquote className="bg-pi-bg2 p-3 rounded-pi-md whitespace-pre-wrap leading-6">{detail.data.validation.entry.text}</blockquote>}
          <KnowledgeMethod value={detail.data.validation?.entry} />
          {detail.data.state === 'review_required' && !detail.data.resolution && <p className="text-pi-dim">先核查原始资料；可以在下方为这项任务补充证据。补证保留原任务记录，不会自动批准结论。</p>}
          <KnowledgeReview key={`${detail.data.id}:${detail.data.revision}`} job={detail.data} policyRevision={policyRevision} refreshed={refreshQueue} />
          {policyRevision && !detail.data.resolution && ['review_required','blocked'].includes(detail.data.state) && <KnowledgeSource parent={detail.data} revision={policyRevision} refreshed={async () => { await Promise.all([list.mutate(), detail.mutate(), refreshed()]) }} />}
          <div className="flex flex-wrap gap-2">
            {!detail.data.resolution && !['committed','cancelled','skipped','failed','paused'].includes(detail.data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(detail.data!, 'pause')}>暂停任务</button>}
            {!detail.data.resolution && detail.data.state === 'paused' && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(detail.data!, 'resume')}>继续任务</button>}
            {!detail.data.resolution && ['blocked','retry_wait','failed'].includes(detail.data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(detail.data!, 'retry')}>重试任务</button>}
            {!detail.data.resolution && !['committed','cancelled','skipped','failed'].includes(detail.data.state) && <button className="btn-tool min-h-11 px-3" disabled={busy} onClick={() => act(detail.data!, 'cancel')}>取消任务</button>}
          </div>
        </>}
      </div>}
    </li>)}</ul>
    {!!list.data?.total && <nav className="flex flex-wrap gap-3 items-center" aria-label="知识队列分页">
      <button className="btn-tool min-h-11 px-3" disabled={offset === 0} onClick={() => {setOffset(n => Math.max(0,n - 20)); setSelected(null)}}>上一页</button>
      <span className="text-pi-dim tabular-nums">第 {Math.floor(offset / 20) + 1} / {Math.max(1,Math.ceil(list.data.total / 20))} 页</span>
      <button className="btn-tool min-h-11 px-3" disabled={offset + 20 >= list.data.total} onClick={() => {setOffset(n => n + 20); setSelected(null)}}>下一页</button>
    </nav>}
  </section>
}
