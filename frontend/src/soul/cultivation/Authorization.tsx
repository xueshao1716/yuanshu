import { useState } from 'react'
import { CultivationApi, type Command, type Challenge } from './api'
import { date, errorText } from '../shared'

export type Action = {method:'PUT'|'POST';path:string;payload:unknown;label:string;revision:number}
export default function Authorization({action,close,refresh}:{action:Action;close:()=>void;refresh:()=>Promise<unknown>}) {
  const [challenge,setChallenge]=useState<Challenge|null>(null),[command,setCommand]=useState<Command|null>(null)
  const [signature,setSignature]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const prepare=async()=>{
    setBusy(true);setMessage('');setSignature('');setChallenge(null)
    try {const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.challenge(cmd);setCommand(cmd);setChallenge(next)
    } catch(e){setMessage(errorText(e))} finally{setBusy(false)}
  }
  const submit=async()=>{
    if(!challenge||!command||busy)return
    setBusy(true);setMessage('')
    try {await CultivationApi.execute(command,{id:challenge.id,signature:signature.trim()});setChallenge(null);setSignature('');
      setMessage('已提交。正在重新读取状态。');await refresh();close()
    } catch(e){setMessage(`${errorText(e)}。请刷新核对结果；签名已作废，不要重复提交。`);setChallenge(null)} finally{setBusy(false)}
  }
  return <section className="soul-notice" aria-label="人工授权确认">
    <h4>{action.label}</h4><p>请先核对本次操作。使用你保管的签名密钥批准，访问令牌不能代替本人授权。私钥不要粘贴到网页。</p>
    <pre className="cultivation-json">{JSON.stringify({method:action.method,path:action.path,revision:action.revision,payload:action.payload},null,2)}</pre>
    <div className="soul-actions"><button disabled={busy} onClick={()=>void prepare()}>{challenge?'重新生成授权请求':'生成授权请求'}</button><button disabled={busy} onClick={close}>返回，不操作</button></div>
    {challenge&&command&&<>
      <p>请求有效期至 {date(challenge.expiresAt)}。将下方内容交给本机签名助手核对，过期后可重新生成。</p>
      <label>待签名内容<textarea readOnly rows={6} value={JSON.stringify({...challenge,command},null,2)} onFocus={e=>e.target.select()}/></label>
      <label>一次性签名<input autoComplete="off" value={signature} onChange={e=>setSignature(e.target.value)} placeholder="粘贴签名助手输出的签名"/></label>
      <button disabled={busy||!signature.trim()} onClick={()=>void submit()}>确认并执行{action.label}</button>
    </>}
    {message&&<p role="status">{message}</p>}
  </section>
}
