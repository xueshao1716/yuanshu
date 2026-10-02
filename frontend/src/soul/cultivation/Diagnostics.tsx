import { useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { CultivationApi, statusLabel, type Agent, type Design, type Preflight } from './api'
import { date, errorText, LoadState } from '../shared'

const readOptions={revalidateOnFocus:false,shouldRetryOnError:false}
const actions:Record<string,string>={'agent.register':'登记个体','run.submit':'提交培养任务','run.dispatch':'执行培养任务'}

export default function Diagnostics({revision}:{revision:number}) {
  const [open,setOpen]=useState(false)
  return <details onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>操作检查与近期拒绝</summary>
    <p className="soul-hint">只检查配置，不修改授权、不创建个体、不调用模型。目录存在不代表模型可用。</p>
    {open&&<Checks revision={revision}/>}
  </details>
}

function Checks({revision}:{revision:number}) {
  const [action,setAction]=useState('agent.register'),[cursor,setCursor]=useState<string|null>(null),[target,setTarget]=useState('')
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const [result,setResult]=useState<{value:Preflight;target:string}|null>(null)
  const request=useRef(0),kind=action==='agent.register'?'designs':'agents'
  const list=useSWR(['cultivation-check-targets',kind,cursor,revision],()=>CultivationApi.list<Design|Agent>(kind,cursor),readOptions)
  const current=!!target&&!!list.data?.items.some(item=>item.id===target)
  const stale=!!result&&(result.value.revision!==revision||result.value.action!==action||result.target!==target)
  useEffect(()=>{request.current++;setBusy(false);return()=>{request.current++}},[revision,action,target,cursor])
  useEffect(()=>{setCursor(null);setTarget('')},[revision])
  const check=async()=>{
    if(!current||busy||list.error)return
    const ticket=++request.current;setBusy(true);setError('');setResult(null)
    try{
      const value=await CultivationApi.preflight({action,...(kind==='designs'?{designId:target}:{agentId:target})})
      if(ticket===request.current)setResult({value,target})
    }catch(e){if(ticket===request.current)setError(errorText(e))}
    finally{if(ticket===request.current)setBusy(false)}
  }
  const retryList=()=>list.mutate().catch(()=>undefined)
  return <section aria-label="培养操作检查">
    <label>要检查的操作<select value={action} onChange={e=>{setAction(e.target.value);setCursor(null);setTarget('');setError('')}}>
      {Object.entries(actions).map(([key,label])=><option key={key} value={key}>{label}</option>)}
    </select></label>
    <LoadState error={list.error} loading={list.isLoading} retry={retryList}/>
    {list.data&&!list.error&&<>
      {!list.data.items.length?<p>当前页没有{kind==='designs'?'设计稿':'个体'}。{kind==='designs'?'可先保存设计草稿，再检查登记条件。':'先在设计稿页登记个体，运行前仍须核对授权与额度。'}</p>:
        <label>{kind==='designs'?'选择设计稿':'选择个体'}<select value={target} onChange={e=>{setTarget(e.target.value);setError('')}}>
          <option value="">请选择检查对象</option>
          {list.data.items.map(item=><option key={item.id} value={item.id}>{'design' in item?item.design.name:statusLabel(item.status)} · {item.id}</option>)}
        </select></label>}
      <nav className="soul-actions" aria-label="检查对象分页">
        {cursor&&<button onClick={()=>{setCursor(null);setTarget('')}}>返回第一页</button>}
        {list.data.nextCursor&&<button onClick={()=>{setCursor(list.data!.nextCursor);setTarget('')}}>下一页对象</button>}
      </nav>
    </>}
    <button disabled={!current||busy||!!list.error} onClick={()=>void check()}>{busy?'正在检查…':'重新检查'}</button>
    {error&&<p role="alert">检查未完成：{error}。可重新读取对象后再检查；无需重复提交写入请求。</p>}
    {stale&&<p role="status">数据已变化，旧检查结果不再适用。请选择当前对象重新检查。</p>}
    {result&&!stale&&<div aria-live="polite">
      <p role="status">{result.value.ready?'静态配置检查通过，尚未执行。':`发现 ${result.value.blockedBy.length} 项阻碍。`}</p>
      <small>检查于 {date(result.value.checkedAt)} · 版本 {result.value.revision}</small>
      <ul className="cultivation-list">{result.value.blockedBy.map((b,i)=><li key={`${b.field}-${i}`}>
        <strong>{b.message}</strong><p>{b.nextAction}</p><small>{b.field} · {b.code}</small>
      </li>)}</ul>
      {result.value.warnings.map((b,i)=><p key={i}>{b.message}。{b.nextAction}</p>)}
      <p>{result.value.nextAction}</p>
      <p className="soul-hint">提交时仍核对身份、最新版本、设计归属、实时名额和实际费用。本页不会授予权限或保证调用成功。</p>
    </div>}
    <Catalog revision={revision}/><History/>
  </section>
}

function Catalog({revision}:{revision:number}) {
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[page,setPage]=useState(0)
  const catalog=useSWR(open?['cultivation-model-directory',revision]:null,()=>CultivationApi.models(),readOptions)
  const items=(catalog.data?.models||[]).filter(m=>`${m.key} ${m.label}`.toLowerCase().includes(query.toLowerCase()))
  const offset=Math.min(page,Math.max(0,Math.ceil(items.length/20)-1))*20
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>模型标识与授权范围</summary>
    {open&&<>
      <LoadState error={catalog.error} loading={catalog.isLoading} retry={()=>catalog.mutate().catch(()=>undefined)}/>
      {catalog.data&&!catalog.error&&(!catalog.data.available?<p role="status">模型目录暂不可读或正在变化，请重新读取。不是空白名单，也不是探活失败。</p>:<>
        <p className="soul-hint">精确标识格式为“提供方/模型”。所有条目尚未探活；此处只读取配置，不产生调用费用。</p>
        <label>查找模型<input value={query} maxLength={200} onChange={e=>{setQuery(e.target.value);setPage(0)}}/></label>
        {!items.length&&<p>没有匹配的文本模型。请在模型管理核对配置。</p>}
        <ul className="cultivation-list">{items.slice(offset,offset+20).map(m=><li key={m.key}><strong>{m.label}</strong><p><code>{m.key}</code></p>
          <small>培养授权：{m.cultivationAuthorized?'已列入':'未列入'} · 共享授权：{m.sharedAuthorized?'已列入':'未列入'} · 尚未探活</small>
        </li>)}</ul>
        {items.length>20&&<nav className="soul-actions" aria-label="模型目录分页"><button disabled={offset===0} onClick={()=>setPage(offset/20-1)}>上一页</button>
          <span>{offset+1}–{Math.min(offset+20,items.length)} / {items.length}</span><button disabled={offset+20>=items.length} onClick={()=>setPage(offset/20+1)}>下一页</button></nav>}
      </>)}
      <button onClick={()=>void catalog.mutate().catch(()=>undefined)}>重新读取模型目录</button>
    </>}
  </details>
}

function History() {
  const [open,setOpen]=useState(false)
  const history=useSWR(open?'cultivation-denials':null,()=>CultivationApi.denials(),readOptions)
  return <details onToggle={e=>setOpen(e.currentTarget.open)}><summary>近期被拒操作</summary>
    {open&&<>
      <LoadState error={history.error} loading={history.isLoading} retry={()=>history.mutate().catch(()=>undefined)}/>
      <p className="soul-hint">仅记录已识别身份、未被接受的请求，不包含任务正文。显示最近 20 条，最多保留 200 条；空列表不代表从未失败。</p>
      {history.data&&!history.error&&(!history.data.items.length?<p>暂无可读取的拒绝记录。</p>:<ul className="cultivation-list">
        {history.data.items.map((item,i)=><li key={`${item.requestId}-${i}`}><strong>{actions[item.action]||item.action}</strong> · {item.error}
          <small>{date(item.lastAt)} · 同请求记录 {item.count} 次 · 请求版本 {item.expectedRevision}</small>
        </li>)}
      </ul>)}
      <button onClick={()=>void history.mutate().catch(()=>undefined)}>刷新拒绝记录</button>
    </>}
  </details>
}
