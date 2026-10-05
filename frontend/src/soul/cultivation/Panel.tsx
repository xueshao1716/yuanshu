import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { Block, LoadState, date, errorText } from '../shared'
import { CultivationApi, cultivationPolling, statusLabel, type Agent, type Design, type Run, type Experience } from './api'
import Individuals from './Individuals'
import Resources from './Resources'
import Learning from './Learning'
import Authorization, { type Action } from './Authorization'
import './cultivation.css'

const tabs=[['resources','授权与资源（先从这里）'],['agents','个体与设计'],['runs','运行时间线'],['experience','学习证据']] as const
type Tab=typeof tabs[number][0]
export default function Cultivation({sessionId}:{sessionId:string}) {
  const [tab,setTab]=useState<Tab>('resources'),[cursor,setCursor]=useState<string|null>(null),[action,setAction]=useState<Action|null>(null)
  const [designCursor,setDesignCursor]=useState<string|null>(null),[error,setError]=useState('')
  const {mutate}=useSWRConfig()
  const overview=useSWR('cultivation-overview',CultivationApi.overview,cultivationPolling)
  const authorized=!!overview.data?.humanGrantAvailable
  const agents=useSWR(tab==='agents'?['cultivation-agents',cursor]:null,()=>CultivationApi.list<Agent>('agents',cursor),cultivationPolling)
  const designs=useSWR(tab==='agents'?['cultivation-designs',designCursor]:null,()=>CultivationApi.list<Design>('designs',designCursor),cultivationPolling)
  const runs=useSWR(tab==='runs'?['cultivation-runs',cursor]:null,()=>CultivationApi.list<Run>('runs',cursor),cultivationPolling)
  const experience=useSWR(tab==='experience'?['cultivation-experience',cursor]:null,()=>CultivationApi.list<Experience>('experience',cursor),cultivationPolling)
  const current=tab==='agents'?agents:tab==='runs'?runs:experience
  const refresh=async()=>{await mutate(key=>typeof key==='string'?key.startsWith('cultivation-'):Array.isArray(key)&&String(key[0]).startsWith('cultivation-'))}
  const retry=async(fn:()=>Promise<unknown>)=>{setError('');try{await fn()}catch(e){setError(errorText(e))}}
  return <div className="cultivation-panel">
    <Block title="她的培养空间" hint="小语自己设计和培养，你只需查看方案并放权。">
      <LoadState error={overview.error} loading={overview.isLoading} retry={()=>retry(overview.mutate)}/>
      {overview.data?.state==='waiting_for_design'&&<p className="soul-notice">等待小语提交设计。尚无个体、课程或运行结果。</p>}
      {overview.data?.state==='waiting_for_design'&&<p className="soul-hint">小语在对话里设计好方案后会提交到这里。</p>}
      <div className="soul-actions" aria-label="培养记录分区">{tabs.map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>{setTab(id);setCursor(null);setAction(null);setError('')}}>{label}</button>)}<button onClick={()=>{setCursor(null);setDesignCursor(null);void retry(refresh)}}>刷新记录</button></div>
      {error&&<p role="alert">刷新失败：{error}。保留当前内容，可再次刷新。</p>}
    </Block>
    {action&&<Authorization key={JSON.stringify([sessionId,action])} action={action} owner={overview.data?.ownerConfirmation} sessionId={sessionId} sessionGrantAvailable={!!overview.data?.sessionGrantAvailable} close={()=>setAction(null)} refresh={refresh}/>}
    <Block title={tabs.find(([id])=>id===tab)![1]}>
      {tab!=='resources'&&<LoadState error={current.error} loading={current.isLoading} retry={()=>{setCursor(null);return retry(current.mutate)}}/>}
      {tab==='agents'&&<><LoadState error={designs.error} loading={designs.isLoading} retry={()=>{setDesignCursor(null);return retry(designs.mutate)}}/><Individuals agents={agents.data?.items||[]} designs={designs.data?.items||[]} authorized={authorized} onAction={setAction}/><div className="soul-actions" aria-label="设计分页"><button disabled={!designCursor} onClick={()=>setDesignCursor(null)}>设计第一页</button><button disabled={!designs.data?.nextCursor} onClick={()=>setDesignCursor(designs.data?.nextCursor||null)}>下一页设计</button></div></>}
      {tab==='runs'&&runs.data&&<><p className="soul-hint">取消后外部请求可能还在跑，费用未知时先保留预留。</p>{!runs.data.items.length&&<p>还没有运行记录。</p>}<ol className="cultivation-list">{runs.data.items.map(run=><li key={run.id}><h4>{statusLabel(run.status)} · {date(run.createdAt)}</h4><p>个体 {run.cultivation.agentId} · 设计 {run.cultivation.designId}</p>{run.cultivation.reason&&<p>{run.cultivation.reason}</p>}{run.cultivation.output&&<details><summary>查看任务输出（模型生成，尚未核验）</summary><p className="cultivation-output">{run.cultivation.output}</p></details>}{['queued','running'].includes(run.status)&&<button disabled={!authorized} onClick={()=>setAction({method:'POST',path:`/runs/${run.id}/cancel`,payload:{},revision:overview.data!.revision,label:'取消任务'})}>取消任务</button>}</li>)}</ol></>}
      {tab==='experience'&&experience.data&&<Learning items={experience.data.items} coverage={experience.data.coverage} stale={!!experience.error} authorized={authorized} onAction={setAction}/>}
      {tab==='resources'&&overview.data&&<Resources value={overview.data} sessionId={sessionId} onAction={setAction} refresh={refresh}/>}
      {tab!=='resources'&&<div className="soul-actions"><button disabled={!cursor} onClick={()=>setCursor(null)}>回到第一页</button><button disabled={!current.data?.nextCursor} onClick={()=>setCursor(current.data?.nextCursor||null)}>下一页</button></div>}
    </Block>
  </div>
}
