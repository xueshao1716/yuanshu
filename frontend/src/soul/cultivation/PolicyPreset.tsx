import { useState } from 'react'
import useSWR from 'swr'
import { CultivationApi, cultivationPolling, type Design, type Overview } from './api'
import type { Action } from './Authorization'
import { LoadState } from '../shared'

export default function PolicyPreset({value,authorized,onAction}:{value:Overview;authorized:boolean;onAction:(a:Action)=>void}) {
  const [cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState('')
  const records=useSWR(['cultivation-preset-designs',cursor],()=>CultivationApi.list<Design>('designs',cursor),cultivationPolling)
  const row=records.data?.items.find(d=>d.id===selected)
  const supported=!!row&&row.design.permissions.tools.length===0&&row.design.permissions.costUpperBoundCents<=50&&
    row.design.permissions.dataScopes.every(s=>s==='knowledge:approved-cultivation')
  const prepare=()=>{
    if(!row||!supported||records.error||records.isValidating||!authorized)return
    onAction({method:'PUT',path:'/policy',revision:value.revision,label:`开启七天受限培养 · ${row.design.name}`,payload:{policy:{
      enabled:true,maxAgents:1,maxConcurrent:1,dailyRequests:1,dailyBudgetCents:50,currency:'USD',
      allowRemote:true,recursive:false,models:[row.design.permissions.model],tools:[],dataScopes:['knowledge:approved-cultivation'],
      expiresAt:new Date(Date.now()+7*86400000).toISOString(),timeoutMs:60000,motherLearning:false,
      schedule:{timezone:'UTC',days:[0,1,2,3,4,5,6],startMinute:0,endMinute:1440},
    }}})
  }
  return <section aria-label="受限智能体培养">
    <h4>让她开始培养一个智能体</h4>
    <p>从小语已提交的设计选择模型：七天有效，最多一个个体、每天一次模型请求、每天最多 0.50 美元。仅限文本任务与已批准的培养知识，不授予工具、电脑操作、私人记忆或递归繁殖权限。</p>
    <p>这会替换当前培养策略。确认策略不能自动开始付费任务；小语仍须登记个体并提交任务，共享知识授权、模型价格与余额也须满足。母体自主采用经验保持关闭。</p>
    <LoadState error={records.error} loading={records.isLoading} retry={()=>records.mutate()}/>
    <label>用哪份设计开始<select value={row?selected:''} onChange={e=>setSelected(e.target.value)}>
      <option value="">选择已提交的设计</option>
      {records.data?.items.map(d=><option key={d.id} value={d.id}>{d.design.name} · {d.design.permissions.model} · {d.id.slice(0,8)}</option>)}
    </select></label>
    {records.data&&!records.data.items.length&&<p>本页没有设计；先让小语提交设计，再刷新记录。</p>}
    {row&&!supported&&<p role="status">这份设计超出受限文本预设的范围，请先调整设计或在下方核对完整资源设置。</p>}
    {row&&!row.design.permissions.remote&&<p>该设计仍标记为本地调用；你确认后，小语需要仅将 remote 改为 true，再用新设计登记个体。不需要增加 tools。</p>}
    <div className="soul-actions">
      <button disabled={!cursor} onClick={()=>{setCursor(null);setSelected('')}}>返回设计首页</button>
      <button disabled={!records.data?.nextCursor} onClick={()=>{setCursor(records.data?.nextCursor||null);setSelected('')}}>更多培养设计</button>
      <button disabled={!authorized||!supported||!!records.error||records.isValidating} onClick={prepare}>核对七天受限培养</button>
    </div>
  </section>
}
