import { useState } from 'react'
import { EvolutionApi } from '../api'

interface Evaluation {
  id: string; status: string; questions: string[]
  original: { answers: string[] }
  variants: { answers: string[] }[]
  model?: { provider: string; id: string }
  calls?: { actualModel: { provider: string; id: string } | null }[]
}

export default function EvolutionReview({ id, index, evaluation, onChange }: {
  id: string; index: number; evaluation: Evaluation; onChange: () => Promise<unknown>
}) {
  const [comparisons, setComparisons] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const models = [...new Set((evaluation.calls || []).map(c => c.actualModel ? `${c.actualModel.provider}/${c.actualModel.id}` : '未知'))]
  const ready = evaluation.questions.every((_, i) => ['better', 'equal'].includes(comparisons[i])) && comparisons.includes('better') && !!note.trim()
  const apply = async () => {
    setBusy(true)
    try {
      const r = await EvolutionApi.apply(id, index, { evaluationId: evaluation.id, comparisons, note })
      setMessage(r.ok ? `已应用，原版备份：${r.backup}` : r.error || '应用失败')
      if (r.ok) await onChange()
    } catch (e) { setMessage(e instanceof Error ? e.message : '保存或刷新失败，请重新核对记录') }
    finally { setBusy(false) }
  }
  return <details className="mt-2 text-[13px] min-w-0">
    <summary className="min-h-11 flex items-center cursor-pointer">查看原版与候选回答，独立验收</summary>
    <p className="text-pi-dim">模型分数只作参考。同模型出题与自评不代表独立验证，也不证明新任务泛化能力。请核对每题，至少一题改善且无退步才能采用。</p>
    <p className="text-pi-dim break-all">请求模型：{evaluation.model ? `${evaluation.model.provider}/${evaluation.model.id}` : '未记录'} · 实际模型（通道返回）：{models.join('、') || '未记录'}</p>
    <fieldset disabled={busy} className="space-y-3 mt-3">
      <legend className="sr-only">逐题核对</legend>
      {evaluation.questions.map((q, i) => <div key={i} className="space-y-2 min-w-0">
        <p className="text-pi-text break-words">{i + 1}. {q}</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[['原版', evaluation.original.answers[i]], ['候选', evaluation.variants[index]?.answers[i]]].map(([label, answer]) => <div key={label} className="min-w-0">
            <p className="text-pi-dim">{label}</p>
            <pre className="font-sans whitespace-pre-wrap break-words max-h-64 overflow-y-auto text-pi-text">{answer || '无完整回答'}</pre>
          </div>)}
        </div>
        <label className="block text-pi-text">第 {i + 1} 题对比结论
          <select className="input min-h-11 w-full mt-1" value={comparisons[i] || ''} onChange={e => setComparisons(old => { const next = [...old]; next[i] = e.target.value; return next })}>
            <option value="">请核对后选择</option><option value="better">候选更好</option><option value="equal">没有退步</option><option value="worse">候选退步，不能采用</option>
          </select>
        </label>
      </div>)}
      <label className="block text-pi-text">核对说明<textarea className="input w-full mt-1" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="具体改善了什么，核对了哪些风险" /></label>
      <button type="button" className="btn-primary min-h-11 px-3" disabled={!ready || busy} onClick={() => void apply()}>{busy ? '保存中…' : '确认对照结果并应用'}</button>
    </fieldset>
    <p role="status" aria-live="polite" className="text-pi-dim break-words">{message}</p>
  </details>
}
