import { useState } from 'react'
import { KnowledgeApi, knowledgeError, type KnowledgeJob } from './api'

export default function KnowledgeReview({ job, policyRevision, refreshed }: { job: KnowledgeJob; policyRevision?: number; refreshed: () => Promise<unknown> }) {
  const [decision, setDecision] = useState('accept_source'), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false)
  const [selectedEntryId, setSelectedEntryId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const eligible = ['source_conflict', 'correction_requires_review'].includes(job.reason || '')
  return <div className="space-y-3">
    {!!job.reviews?.length && <details><summary className="min-h-11 cursor-pointer py-2">人工复核记录 · {job.reviews.length}</summary>
      <ul className="space-y-2">{job.reviews.map((review, index) => <li key={index} className="leading-6">
        {new Date(review.at).toLocaleString('zh-CN')} · {review.decision === 'accept_source' ? '选择本条来源' : review.decision === 'keep_existing' ? '保留现有来源' : '不采用'}<br />{review.note}
      </li>)}</ul>
    </details>}
    {job.state === 'review_required' && !job.resolution && policyRevision && <details className="border-t border-pi-border-soft pt-2">
      <summary className="min-h-11 cursor-pointer py-2 font-medium">人工核对并裁决</summary>
      <form className="space-y-3" onSubmit={async event => {
        event.preventDefault(); if (busy || !confirmed) return; setBusy(true); setError('')
        try {
          await KnowledgeApi.review(job.id, { decision: eligible ? decision : 'reject', note, confirmed, selectedEntryId }, job.revision, policyRevision)
          setConfirmed(false); setNote(''); await refreshed()
        } catch (e) { setError(knowledgeError(e)) } finally { setBusy(false) }
      }}>
        <fieldset disabled={busy} className="space-y-3">
          <legend className="sr-only">知识来源人工裁决</legend>
          <p className="text-pi-dim leading-6">只选择哪一份来源可被引用，不将来源陈述变成已验证事实，也不批准技能、人格、基因或天团终稿。提交后会重新核对来源及授权。</p>
          {eligible ? <label className="block">采用哪一份来源<select className="input-pi min-h-11 w-full mt-1" value={decision} onChange={e => setDecision(e.target.value)}>
            <option value="accept_source">采用本条来源，冲突旧版保留归档</option>
            {!!job.validation?.conflicts?.length && <option value="keep_existing">保留一条现有来源，不采用本条</option>}
            <option value="reject">暂不采用，保留记录</option>
          </select></label> : <p className="text-pi-dim">此内容缺少独立证据或含不可信指令，不能人工绕过证据门；本处只能选择不采用。</p>}
          {decision === 'keep_existing' && eligible && <label className="block">有效的现有来源<select required className="input-pi min-h-11 w-full mt-1" value={selectedEntryId} onChange={e => setSelectedEntryId(e.target.value)}>
            <option value="">请选择已核对的来源</option>{job.validation?.conflicts?.map(id => <option key={id} value={id}>{job.reviewOptions?.find(e => e.id === id)?.text || id.slice(0, 12)}</option>)}
          </select></label>}
          {job.candidate?.text && <p className="text-pi-text leading-6 whitespace-pre-wrap">本条候选原文：{job.candidate.text}</p>}
          {!!job.reviewOptions?.length && <ul className="space-y-2">{job.reviewOptions.map(entry => <li key={entry.id} className="text-pi-dim leading-6">现有资料：{entry.text}<br />{entry.sources.map(s => s.locator).join('；')}</li>)}</ul>}
          <label className="block">核对依据与选择理由<textarea required maxLength={1000} className="input-pi min-h-22 w-full mt-1" rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>
          <label className="min-h-11 flex items-center gap-2"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对原始来源，确认本次选择</label>
          {error && <p role="alert">{error}</p>}
          <button className="btn-primary min-h-11 px-4 disabled:opacity-50" disabled={busy || !confirmed || !note.trim()}>{busy ? '正在记录…' : '记录人工裁决'}</button>
        </fieldset>
      </form>
    </details>}
  </div>
}
