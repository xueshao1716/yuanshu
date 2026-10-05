import { useState } from 'react'
import useSWR from 'swr'
import { SoulApi } from './api'
import { Block, geneLabels, LoadState } from './shared'
import { listLines } from './draft.mjs'
type Props = {sessionId: string; busy: boolean; run: (work: () => Promise<unknown>) => Promise<boolean>}
export default function Genes({sessionId, busy, run}: Props) {
  const state = useSWR('soul-genome', SoulApi.genome)
  const [gene,setGene] = useState('gentleness'), [value,setValue] = useState('0.8'), [reason,setReason] = useState(''), [evidence,setEvidence] = useState('')
  const [rejecting,setRejecting] = useState(''), [rejectReason,setRejectReason] = useState('')
  const act = async (action: string, body: unknown) => {const ok = await run(() => SoulApi.gene(action, body)); await state.mutate(); return ok}
  return <>
    <LoadState error={state.error} loading={state.isLoading} retry={state.mutate} />
    <Block title="长期基线与当前表现" hint="基线是你批准过的长期设定，表现随互动变化。">
      <div className="soul-table-wrap"><table><thead><tr><th>维度</th><th>批准基线</th><th>当前表现</th><th>偏移</th></tr></thead><tbody>
        {Object.entries(state.data?.genes || {}).map(([key,g]) => <tr key={key}><th scope="row">{geneLabels[key] || key}</th><td>{g.baseline.toFixed(3)}</td><td>{g.expression.toFixed(3)}</td><td>{(g.expression - g.baseline).toFixed(3)}</td></tr>)}
      </tbody></table></div>
    </Block>
    <Block title="提出基线调整" hint="提案进入待审，不会立刻改人格；批准时核验证据。">
      <fieldset disabled={busy || !!state.error || !state.data} className="soul-form">
        <label>培养维度<select value={gene} onChange={e => {setGene(e.target.value); setValue(String(state.data?.genes[e.target.value]?.baseline ?? ''))}}>{Object.keys(state.data?.genes || {}).map(key => <option key={key} value={key}>{geneLabels[key] || key}</option>)}</select></label>
        <label>建议基线（0–1）<input type="number" min="0" max="1" step="0.01" value={value} onChange={e => setValue(e.target.value)} /></label>
        <label className="soul-wide">调整理由<textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></label>
        <label className="soul-wide">已有证据引用（每行一条）<textarea value={evidence} onChange={e => setEvidence(e.target.value)} placeholder="粘贴已有的 source-file 或 gene-event 引用" /></label>
      </fieldset>
      <details className="soul-details"><summary>证据格式与自动提案规则</summary><p>文件引用：source-file:工作空间相对路径 sha256:文件的64位摘要。只接受可读取的 md、txt、jsonl、json 文件；摘要一致只证明文件未变，不证明内容为真。</p><p>自动提案需要至少3条合格、同向互动观测，跨度不少于24小时；不会生成虚构证据或自动批准。</p></details>
      <div className="soul-actions"><button className="soul-primary" disabled={busy || !state.data || !!state.error || !reason.trim() || !evidence.trim() || !value || !Number.isFinite(Number(value)) || Number(value)<0 || Number(value)>1} onClick={() => void act('propose', {gene,value:Number(value),reason,evidence:listLines(evidence)})}>保存为待审提案</button>
        <button disabled={busy || !state.data || !!state.error} onClick={() => void act('auto', {})}>检查现有观测并生成提案</button></div>
    </Block>
    <Block title="待审提案" hint="批准需要本机确认；证据不够时会说明原因。">
      {!state.isLoading && state.data && !state.data.proposals.some(p => p.status === 'pending') && <p>暂无待审提案。</p>}
      {state.data?.proposals.filter(p => p.status === 'pending').map(p => <article className="soul-record" key={p.proposal_id}>
        <h4>{geneLabels[p.gene] || p.gene} · {p.current_baseline} → {p.proposed_baseline}</h4><p>{p.reason || '未提供理由'}</p>
        <details><summary>查看证据 · {p.evidence.length} 条</summary><ul>{p.evidence.map((e,i) => <li key={i}>{String(e)}</li>)}</ul></details>
        <div className="soul-actions"><button disabled={busy || !sessionId} onClick={() => void act('approve', {proposal_id:p.proposal_id,sessionId})}>请求批准</button><button disabled={busy} onClick={() => setRejecting(p.proposal_id)}>拒绝提案…</button></div>
        {rejecting === p.proposal_id && <div><label className="soul-field">拒绝理由<input value={rejectReason} onChange={e => setRejectReason(e.target.value)} /></label><button disabled={busy || !rejectReason.trim()} onClick={() => void act('reject', {proposal_id:p.proposal_id,reason:rejectReason}).then(ok => {if(ok){setRejecting('');setRejectReason('')}})}>确认拒绝</button></div>}
      </article>)}
    </Block>
  </>
}
