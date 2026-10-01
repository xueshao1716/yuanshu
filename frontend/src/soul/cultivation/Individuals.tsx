import { useState } from 'react'
import useSWR from 'swr'
import { CultivationApi, cultivationPolling, statusLabel, type Agent, type Design } from './api'
import { LoadState, errorText } from '../shared'
import type { Action } from './Authorization'
import Media from './Media'

export function DesignView({row}:{row:Design}) {
  const d=row.design
  return <div className="cultivation-design">
    <h4>{d.name}</h4><p>{d.rationale}</p>
    <dl className="soul-facts"><div><dt>设计作者</dt><dd>{row.author.actorId}</dd></div><div><dt>设计版本</dt><dd>{row.id}</dd></div></dl>
    <h4>目标与课程</h4><ul>{d.goals.map((s,i)=><li key={i}>{s}</li>)}</ul><ol>{d.curriculum.map((s,i)=><li key={i}>{s}</li>)}</ol>
    <p>暂时表达：{d.temporaryExpression}</p><p>观察方法：{d.observation}</p><p>恢复方式：{d.recovery}</p>
    <dl>{([['appearance','人物外貌'],['clothing','服装设计'],['voice','声音设计']] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{d[key].description}<br/>{d[key].asset?`个体绑定资产 ${d[key].asset.id} · 版本 ${d[key].asset.version}`:'尚未绑定媒体资产'}</dd></div>)}</dl>
    <p>指定模型：{d.permissions.model} · 单次预算上限 {d.permissions.costUpperBoundCents} 美分</p>
  </div>
}
export default function Individuals({agents,designs,authorized,onAction}:{agents:Agent[];designs:Design[];authorized:boolean;onAction:(a:Action)=>void}) {
  const [selected,setSelected]=useState<string|null>(null)
  const [error,setError]=useState('')
  const detail=useSWR(selected?['cultivation-agent',selected]:null,()=>CultivationApi.agent(selected!),cultivationPolling)
  return <>
    {!agents.length&&<p className="soul-hint">还没有登记个体。设计与注册由小语提交，页面不会替她编写人格。</p>}
    <ul className="cultivation-list">{agents.map(a=><li key={a.id}><button aria-expanded={selected===a.id} onClick={()=>setSelected(selected===a.id?null:a.id)}>{designs.find(d=>d.id===a.designId)?.design.name||`个体 ${a.id.slice(0,8)}`} · {statusLabel(a.status)}</button><small>{a.id}</small></li>)}</ul>
    <LoadState loading={detail.isLoading} error={detail.error} retry={async()=>{try{setError('');await detail.mutate()}catch(e){setError(errorText(e))}}}/>
    {error&&<p role="alert">{error}</p>}
    {detail.data?.agent.id===selected&&<>
      <DesignView row={detail.data.design}/>
      {(['appearance','clothing','voice'] as const).map(kind=><Media key={`${selected}:${kind}:${detail.data!.design.id}:${detail.data!.design.design[kind].asset?.id}`} agentId={selected!} kind={kind} design={detail.data!.design.design[kind]} revision={detail.data!.revision} authorized={authorized} onAction={onAction}/>)}
      <p>初始化：{detail.data.initialization==='complete'?'完成':'待完成'} · 取消状态：{detail.data.agent.cancellation==='pending_confirmation'?'已请求取消，等待执行器确认':detail.data.agent.cancellation==='confirmed'?'执行器已确认结束':detail.data.agent.cancellation==='outcome_unknown'?'外部结果未知，需要核对':'未请求'}</p>
      <div className="soul-actions">{(detail.data.agent.status==='archived'?[]:detail.data.agent.status==='paused'?['resume','archive']:['pause','archive']).map(action=><button key={action} disabled={!authorized} onClick={()=>onAction({method:'POST',path:`/agents/${selected}/${action}`,payload:{},revision:detail.data!.revision,label:{pause:'暂停个体',resume:'恢复个体',archive:'归档个体'}[action]!})}>{({pause:'暂停',resume:'恢复',archive:'归档'} as Record<string,string>)[action]}</button>)}</div>
      {detail.data.agent.history.length>1&&<label>回退到历史设计<select defaultValue="" disabled={!authorized||detail.data.agent.status==='archived'} onChange={e=>{if(e.target.value)onAction({method:'POST',path:`/agents/${selected}/rollback`,payload:{designId:e.target.value},revision:detail.data!.revision,label:'回退设计'});e.target.value=''}}><option value="">选择已采用的版本</option>{[...new Set(detail.data.agent.history)].filter(id=>id!==detail.data!.agent.designId).map(id=><option key={id} value={id}>{id}</option>)}</select></label>}
    </>}
    <h4>已提交设计</h4>
    {!designs.length&&<p className="soul-hint">暂无设计版本。</p>}
    {designs.map(d=><details key={d.id}><summary>{d.design.name} · {d.id.slice(0,8)}</summary><DesignView row={d}/></details>)}
  </>
}
