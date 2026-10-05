import { useEffect, useRef, useState } from 'react'
import { CultivationApi, type Preflight } from './api'
import { date, errorText } from '../shared'

export default function DesignReadiness({designId,revision,onResult}:{designId:string;revision:number;onResult?:(result:Preflight|null)=>void}) {
  const [result,setResult]=useState<Preflight|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const request=useRef(0)
  const check=async()=>{
    if(busy)return
    const ticket=++request.current;setBusy(true);setError('');setResult(null)
    try{const next=await CultivationApi.preflight({action:'design.check',designId});if(ticket===request.current){setResult(next);onResult?.(next)}}
    catch(e){if(ticket===request.current)setError(errorText(e))}
    finally{if(ticket===request.current)setBusy(false)}
  }
  useEffect(()=>{
    request.current++
    setResult(null);setError('');setBusy(false);onResult?.(null)
    void check()
    return()=>{request.current++}
  },[designId,revision])
  const stale=!!result&&result.revision!==revision
  return <section aria-label="设计运行准备检查">
    <h5>已自动检查运行条件</h5>
    <p>选中方案后自动核对培养策略、共享模型、价格与额度。不调用模型，不修改授权，不登记个体。</p>
    <button disabled={busy} onClick={()=>void check()}>{busy?'正在检查…':'重新检查运行条件'}</button>
    {error&&<p role="alert">检查未完成：{error}。恢复连接后重新检查，无需重复注册。</p>}
    {stale&&<p role="status">配置版本已变化，请重新检查。</p>}
    {result&&!stale&&<div aria-live="polite">
      <p role="status">{result.ready?'静态运行条件已满足，尚未执行。':`运行前还有 ${result.blockedBy.length} 项待核对。`}</p>
      <small>检查于 {date(result.checkedAt)}；共享额度随其他任务变化，提交时仍会重新核验。</small>
      <ul className="cultivation-list">{result.blockedBy.map((b,i)=><li key={`${b.field}-${i}`}>
        <strong>{b.message}</strong><p>{b.nextAction}</p>
        <small>{b.field.startsWith('knowledge.')?'在下方“共享模型与额度设置”核对':'核对培养策略或设计稿'} · {b.field}</small>
      </li>)}</ul>
      {result.warnings.map((b,i)=><p key={i}>{b.message}。{b.nextAction}</p>)}
      <p className="soul-hint">检查通过后仍需你确认放权。</p>
    </div>}
  </section>
}
