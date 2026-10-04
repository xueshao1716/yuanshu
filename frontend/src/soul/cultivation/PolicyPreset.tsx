import { useState } from 'react'
import useSWR from 'swr'
import { CultivationApi, cultivationPolling, type Design, type Overview, type Preflight } from './api'
import type { Action } from './Authorization'
import { LoadState } from '../shared'
import DesignReadiness from './DesignReadiness'

export default function PolicyPreset({value,authorized,onAction}:{value:Overview;authorized:boolean;onAction:(a:Action)=>void}) {
  const [cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState(''),[preflight,setPreflight]=useState<Preflight|null>(null)
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
    <h4>小语的培养方案</h4>
    <p>小语会在对话里完成方案设计并提交到这里。你只需查看方案，等自动预检完成后一次性放权。无需填写课程、模型参数或电脑密码。</p>
    <p>一次性放权不能自动开始付费任务；小语仍须登记个体并提交任务，服务端会再次核对实际资源与费用。</p>
    <LoadState error={records.error} loading={records.isLoading} retry={()=>records.mutate()}/>
    <label>选择小语提交的方案<select value={row?selected:''} onChange={e=>{setSelected(e.target.value);setPreflight(null)}}>
      <option value="">选择已提交的设计</option>
      {records.data?.items.map(d=><option key={d.id} value={d.id}>{d.design.name} · {d.design.permissions.model} · {d.id.slice(0,8)}</option>)}
    </select></label>
    {records.data&&!records.data.items.length&&<p>本页没有设计；先让小语提交设计，再刷新记录。</p>}
    {row&&!supported&&<p role="status">这份设计超出受限文本预设的范围，请先调整设计或在下方核对完整资源设置。</p>}
    {row&&!row.design.permissions.remote&&<p>该设计仍标记为本地调用；你确认后，小语需要仅将 remote 改为 true，再用新设计登记个体。不需要增加 tools。</p>}
    {row&&<dl className="soul-facts"><div><dt>单次费用上限</dt><dd>{row.design.permissions.costUpperBoundCents} 美分</dd></div><div><dt>外部模型请求</dt><dd>{row.design.permissions.remote?'会外发到已授权模型':'不外发'}</dd></div><div><dt>授权长期状态</dt><dd>本次放权最多七天，到期后需重新确认</dd></div></dl>}
    {row&&<DesignReadiness
      key={row.id}
      designId={row.id}
      revision={value.revision}
      onResult={setPreflight}
    />}
    <p className="soul-hint">放权范围固定为七天、最多一个个体、每天一次文本请求、每天最多 0.50 美元；不包含电脑、文件、终端、密码、凭据、工具或私人记忆。外部调用、模型价格和共享额度仍由自动预检与服务端在提交时复核。</p>
    <div className="soul-actions">
      <button disabled={!cursor} onClick={()=>{setCursor(null);setSelected('')}}>返回设计首页</button>
      <button disabled={!records.data?.nextCursor} onClick={()=>{setCursor(records.data?.nextCursor||null);setSelected('')}}>更多培养设计</button>
      <button disabled={!authorized||!supported||!preflight?.ready||preflight.revision!==value.revision||!!records.error||records.isValidating} onClick={prepare}>一次性放权</button>
    </div>
  </section>
}
