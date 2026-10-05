import { useState } from 'react'
import type { Experience, ExperienceCoverage } from './api'
import { statusLabel } from './api'
import type { Action } from './Authorization'
import { date } from '../shared'
import Evidence, { EvidenceSummary } from './Evidence'
const outcomeLabels:Record<string,string>={failed:'执行失败，原因待核验',cancelled:'已取消',unknown:'实际结果未知',not_completed:'未完成'}

function Decision({item,authorized,onAction}:{item:Experience;authorized:boolean;onAction:(a:Action)=>void}) {
  const [scope,setScope]=useState(item.agentId),[reason,setReason]=useState('')
  const decisions=item.learning.filter(row=>row.scope===scope),last=decisions[decisions.length-1]
  const prepare=(decision:'adopt'|'retire')=>{
    if(item.revision===null||!reason.trim())return
    onAction({method:'POST',path:'/learning',revision:item.revision,
      payload:{jobId:item.knowledgeJobId,scope,decision,reason:reason.trim()},label:decision==='adopt'?'采用已核验经验':'退役经验'})
  }
  return <details><summary>查看采用记录与处理</summary>
    {!item.learning.length?<p>尚无采用记录。</p>:<ol>{item.learning.map((row,i)=><li key={i}>{row.scope==='mother'?'母体':`原个体 ${row.scope}`} · {row.decision==='adopt'?'采用':'退役'} · 版本 {row.version}<p>{row.reason}</p><small>{row.actor.kind==='human'?'人工授权':'母体决定'} · {date(row.at)}</small></li>)}</ol>}
    <p className="soul-hint">采用前服务端会核查独立来源与数据授权。小语只在有效的事先授权内自行采用；撤回只停止后续使用。</p>
    <label>采用范围<select value={scope} onChange={e=>setScope(e.target.value)}><option value={item.agentId}>仅原个体</option><option value="mother">分享给母体</option></select></label>
    <label>处理理由<textarea rows={3} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <div className="soul-actions"><button disabled={!authorized||item.revision===null||!item.resolution||!reason.trim()||last?.decision==='adopt'} onClick={()=>prepare('adopt')}>核对并采用</button><button disabled={!authorized||item.revision===null||!reason.trim()||last?.decision!=='adopt'} onClick={()=>prepare('retire')}>核对并退役</button></div>
  </details>
}
export default function Learning({items,coverage,stale,authorized,onAction}:{items:Experience[];coverage?:ExperienceCoverage;stale:boolean;authorized:boolean;onAction:(a:Action)=>void}) {
  return <><p className="soul-hint">模型输出只是假设，执行记录只说明任务状态，补证要靠独立证据。</p>
    <p className="soul-hint">实际引用不等于验证有效；引用次数不算成长评分。</p>
    <EvidenceSummary items={items} coverage={coverage} stale={stale}/>
    {!stale&&!items.length&&<p>本页暂无记录；任务结束后会留下可追踪记录，包括失败、取消或结果未知。</p>}
    <ul className="cultivation-list">{items.map(item=><li key={item.id}><h4>{statusLabel(item.state)}</h4><p>来源角色：{item.role==='execution_record'?'执行记录':'模型生成'}</p>
      {item.outcome&&<p>任务结果：{outcomeLabels[item.outcome]??'未识别的结果状态'}</p>}
      <Evidence item={item}/><a href={`#/apps?knowledge=${encodeURIComponent(item.knowledgeJobId)}`}>查看知识证据与处理记录</a><Decision item={item} authorized={authorized&&!stale} onAction={onAction}/></li>)}</ul>
  </>
}
