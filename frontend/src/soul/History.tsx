import { useState } from 'react'
import useSWR from 'swr'
import { SoulApi } from './api'
import { Block, date, fieldLabels, geneLabels, LoadState } from './shared'
export default function History({sessionId,busy,run}: {sessionId:string;busy:boolean;run:(work:()=>Promise<unknown>)=>Promise<boolean>}) {
  const persona = useSWR('soul-persona', SoulApi.persona), genome = useSWR('soul-genome', SoulApi.genome)
  const [target,setTarget] = useState<{kind:'persona'|'gene';id:string}|null>(null), [reason,setReason] = useState('')
  const rollback = async () => {
    if (!target) return
    const body = {snapshot_id:target.id,expectedRevision:persona.data?.revision,sessionId,reason}
    const ok = await run(() => target.kind === 'persona' ? SoulApi.rollback(body) : SoulApi.gene('rollback',body))
    await Promise.all([persona.mutate(),genome.mutate()]); if(ok){setTarget(null);setReason('')}
  }
  return <>
    <Block title="人格修订" hint="每次保存包含快照与确认记录。仅能撤回仍位于当前版本末端的修改，不覆盖别人后来的设置。">
      <LoadState error={persona.error} loading={persona.isLoading} retry={persona.mutate} />
      {persona.data?.history.length === 0 && <p>还没有通过此入口保存的修订；旧文件不会被当成已审批历史。</p>}
      {persona.data?.history.map(h => <article key={h.snapshot_id} className="soul-record"><h4>{h.action === 'rollback' ? '回退' : '修改'} · {h.changed.map(k=>fieldLabels[k]||k).join('、')}</h4><p>{date(h.created_at)}</p><p className="soul-hint">确认记录：{h.reviewer}</p>
        <button disabled={busy || !!persona.error || !!persona.data.problems.length || h.appliedRevision !== persona.data.revision || !!h.rolled_back_at} onClick={() => {setTarget({kind:'persona',id:h.snapshot_id});setReason('')}}>{h.rolled_back_at ? '已回退' : h.appliedRevision !== persona.data.revision ? '已有后续版本' : '回退这次修改…'}</button>
      </article>)}
    </Block>
    <Block title="基因快照与审查" hint="复用现有基因治理记录与安全回滚，不改变证据门。">
      <LoadState error={genome.error} loading={genome.isLoading} retry={genome.mutate} />
      {genome.data?.snapshots.length === 0 && <p>尚无批准后生成的基因快照。</p>}
      {[...(genome.data?.snapshots || [])].reverse().map(s => <article className="soul-record" key={s.snapshot_id}><h4>{geneLabels[s.gene] || s.gene} · {s.old_baseline} → {s.applied_baseline}</h4>
        <button disabled={busy || !!genome.error || !!s.rolled_back_at || genome.data?.genes[s.gene]?.revision !== s.snapshot_id} onClick={() => {setTarget({kind:'gene',id:s.snapshot_id});setReason('')}}>{s.rolled_back_at ? '已回退' : '回退此基因…'}</button></article>)}
      <details><summary>查看基因审查记录 · {genome.data?.reviews.length ?? '—'}</summary>{[...(genome.data?.reviews || [])].reverse().map((r,i) => <p key={i}>{r.decision} · {r.reviewer} · {r.reason || r.proposal_id}</p>)}</details>
    </Block>
    {target && <Block title="提交回退请求"><p>回退对象：{target.kind === 'persona' ? '人格修订' : '基因快照'} · {target.id}</p><label className="soul-field">回退理由<textarea value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} /></label><div className="soul-actions"><button className="soul-primary" disabled={busy || !sessionId || !reason.trim()} onClick={() => void rollback()}>请求人工确认回退</button><button disabled={busy} onClick={()=>setTarget(null)}>取消</button></div>{!sessionId && <p>请先选择确认记录所属会话。</p>}</Block>}
  </>
}
