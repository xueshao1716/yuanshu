import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { CultivationApi, cultivationPolling, type Design, type Overview, type Preflight } from './api'
import { KnowledgeApi, knowledgePolling } from '../../knowledge/api'
import type { Action } from './Authorization'
import { LoadState, errorText } from '../shared'
import DesignReadiness from './DesignReadiness'
import { classifyBlocked, grantPolicy, grantSummary, sharedPatch, supportedDesign } from './grant-preset.mjs'

// 放权不能要求调用方已 authorized：它的目的正是把授权从关到开。supported 与记录状态仍要卡。
export default function PolicyPreset({value,onAction,refresh}:{value:Overview;authorized?:boolean;onAction:(a:Action)=>void;refresh?:()=>Promise<unknown>}) {
  const [cursor,setCursor]=useState<string|null>(null),[selected,setSelected]=useState(''),[preflight,setPreflight]=useState<Preflight|null>(null)
  const [sharedBusy,setSharedBusy]=useState(false),[sharedError,setSharedError]=useState(''),[recheck,setRecheck]=useState(0)
  const records=useSWR(['cultivation-preset-designs',cursor],()=>CultivationApi.list<Design>('designs',cursor),cultivationPolling)
  const knowledge=useSWR('knowledge-policy',KnowledgeApi.policy,knowledgePolling)
  const catalog=useSWR('knowledge-models',KnowledgeApi.models)
  const rows=records.data?.items||[]
  // 默认选最新提交的设计（列表按提交顺序，最后一项最新），不让人从三份长得一样的里猜。
  useEffect(()=>{if(!selected&&rows.length)setSelected(rows[rows.length-1].id)},[rows.length,selected])
  const row=rows.find(d=>d.id===selected)
  const fresh=!!preflight&&preflight.revision===value.revision
  const {fixable,shared,stubborn}=classifyBlocked(fresh?preflight!.blockedBy:[],{includeShared:true})
  const model=row?.design.permissions.model||''
  const fix=sharedPatch(knowledge.data,model,catalog.data?.find(m=>m.key===model)?.cost)
  const supported=!!row&&supportedDesign(row.design)
  const grantable=fresh&&stubborn.length===0&&shared.length===0
  const fixShared=async()=>{
    if(!fix?.patch||!knowledge.data)return
    setSharedBusy(true);setSharedError('')
    try{await KnowledgeApi.updatePolicy(fix.patch,knowledge.data.revision);await knowledge.mutate();await refresh?.();setRecheck(n=>n+1)}
    catch(e){setSharedError(errorText(e))}finally{setSharedBusy(false)}
  }
  const prepare=()=>{
    if(!row||!supported||records.error||records.isValidating)return
    onAction({method:'PUT',path:'/policy',revision:value.revision,label:`开启七天受限培养 · ${row.design.name}`,payload:{policy:grantPolicy(row.design)}})
  }
  return <section aria-label="受限智能体培养">
    <h4>小语的培养方案</h4>
    <p>小语在对话里设计方案并提交到这里。默认选中最新一版；核对下面的范围后点一次放权。</p>
    <LoadState error={records.error} loading={records.isLoading} retry={()=>records.mutate()}/>
    {rows.length>1&&<label>方案版本<select value={row?selected:''} onChange={e=>{setSelected(e.target.value);setPreflight(null)}}>
      {rows.map((d,i)=><option key={d.id} value={d.id}>{d.design.name} · 第 {i+1} 版{i===rows.length-1?'（最新）':''}</option>)}
    </select></label>}
    {records.data&&!rows.length&&<p>还没有方案。先让小语在对话里提交设计。</p>}
    {row&&!supported&&<p role="status">这份方案要的权限超出受限预设（工具、费用或数据范围），需要小语先收窄。</p>}
    {row&&<dl className="soul-facts">
      <div><dt>方案</dt><dd>{row.design.name}</dd></div>
      <div><dt>模型</dt><dd>{catalog.data?.find(m=>m.key===model)?.label||model}</dd></div>
      <div><dt>单次费用上限</dt><dd>{row.design.permissions.costUpperBoundCents} 美分</dd></div>
      <div><dt>放权范围</dt><dd>{grantSummary}</dd></div>
    </dl>}
    {row&&<DesignReadiness key={`${row.id}:${recheck}`} designId={row.id} revision={value.revision} onResult={setPreflight}/>}
    {shared.length>0&&<div role="status" className="soul-notice">
      <p>共享模型设置还差 {shared.length} 项：把 {model} 加入共享白名单{fix?.needsManualPrice?'，并填写它的价格':'，并按模型目录标记为免费'}。</p>
      {fix?.needsManualPrice
        ?<p>模型目录里没有它的价格，不能替你猜。请展开下方“共享模型与额度设置”填写单价。</p>
        :<button disabled={sharedBusy||!fix?.patch} onClick={()=>void fixShared()}>{sharedBusy?'正在补齐…':'补齐共享模型设置'}</button>}
      {sharedError&&<p role="alert">补齐失败：{sharedError}</p>}
    </div>}
    {grantable&&fixable.length>0&&<p role="status">剩余 {fixable.length} 项都属于培养授权本身，放权时一并写入。</p>}
    {stubborn.length>0&&<p role="status">还有 {stubborn.length} 项放权修不了，请按上方清单核对。</p>}
    {row&&!row.design.permissions.remote&&<p className="soul-hint">放权后，小语还需把方案标为允许外部调用（只改这一项）再登记个体，不增加工具。</p>}
    <p className="soul-hint">不包含电脑、文件、终端、密码、凭据、工具或私人记忆。放权不会自动开始付费任务，提交时服务端还会复核。</p>
    <div className="soul-actions">
      <button className="soul-primary" disabled={!supported||!grantable||!!records.error||records.isValidating} onClick={prepare}>一次性放权</button>
      {(cursor||records.data?.nextCursor)&&<><button disabled={!cursor} onClick={()=>{setCursor(null);setSelected('')}}>返回方案首页</button>
      <button disabled={!records.data?.nextCursor} onClick={()=>{setCursor(records.data?.nextCursor||null);setSelected('')}}>更多方案</button></>}
    </div>
  </section>
}
