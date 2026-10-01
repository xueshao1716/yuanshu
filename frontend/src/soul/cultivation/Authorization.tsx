import { useRef, useState } from 'react'
import { CultivationApi, type Command, type Challenge, type Overview } from './api'
import { date, errorText } from '../shared'
import {ownerInvoke,ownerError} from './owner'

export type Action = {method:'PUT'|'POST';path:string;payload:unknown;label:string;revision:number}
export default function Authorization({action,owner,close,refresh}:{action:Action;owner?:Overview['ownerConfirmation'];close:()=>void;refresh:()=>Promise<unknown>}) {
  const [challenge,setChallenge]=useState<Challenge|null>(null),[command,setCommand]=useState<Command|null>(null)
  const [signature,setSignature]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const pending=useRef(false),submitted=useRef(false),hello=owner?.mode==='windows-hello'
  const nativeSubmit=async()=>{
    const invoke=ownerInvoke();if(pending.current||submitted.current||!invoke||!owner)return
    pending.current=true;setBusy(true);setMessage('');let stage:'challenge'|'native'|'submit'='challenge'
    try{
      const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.challenge(cmd)
      stage='native';const signature=await invoke<string>('owner_confirmation_sign',{workspace:owner.workspace,request:{...next,command:cmd}})
      stage='submit';submitted.current=true;await CultivationApi.execute(cmd,{id:next.id,signature})
      setMessage('授权已提交，正在重新读取状态。');await refresh();close()
    }catch(e){setMessage(stage==='submit'?`${errorText(e)}。提交结果尚待核对，请刷新记录，不要重复操作。`:stage==='native'?ownerError(e):errorText(e))}
    finally{pending.current=false;setBusy(false)}
  }
  const prepare=async()=>{
    if(pending.current)return;pending.current=true
    setBusy(true);setMessage('');setSignature('');setChallenge(null)
    try {const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.challenge(cmd);setCommand(cmd);setChallenge(next)
    } catch(e){setMessage(errorText(e))} finally{pending.current=false;setBusy(false)}
  }
  const submit=async()=>{
    if(!challenge||!command||pending.current)return
    pending.current=true
    setBusy(true);setMessage('')
    try {await CultivationApi.execute(command,{id:challenge.id,signature:signature.trim()});setChallenge(null);setSignature('');
      setMessage('已提交。正在重新读取状态。');await refresh();close()
    } catch(e){setMessage(`${errorText(e)}。请刷新核对结果；签名已作废，不要重复提交。`);setChallenge(null)} finally{pending.current=false;setBusy(false)}
  }
  return <section className="soul-notice" aria-label="人工授权确认">
    <h4>{action.label}</h4><p>{hello?'请先核对本次操作，接着在 Windows 系统窗口完成本人确认。取消不会提交，确认后自动保存；访问令牌不能代替本人授权。':'请先核对本次操作。使用你保管的签名密钥批准，访问令牌不能代替本人授权。私钥不要粘贴到网页。'}</p>
    <pre className="cultivation-json">{JSON.stringify({method:action.method,path:action.path,revision:action.revision,payload:action.payload},null,2)}</pre>
    <div className="soul-actions">{hello?<button disabled={busy||submitted.current||!ownerInvoke()} onClick={()=>void nativeSubmit()}>{busy?'正在等待本人确认…':'本人确认并执行'}</button>:<button disabled={busy} onClick={()=>void prepare()}>{challenge?'重新生成授权请求':'生成授权请求'}</button>}<button disabled={busy} onClick={close}>{submitted.current?'关闭并核对记录':'返回，不操作'}</button></div>
    {hello&&!ownerInvoke()&&<p role="status">请在新版 Windows 桌面客户端确认；网页不会代签。</p>}
    {challenge&&command&&<>
      <p>请求有效期至 {date(challenge.expiresAt)}。将下方内容交给本机签名助手核对，过期后可重新生成。</p>
      <label>待签名内容<textarea readOnly rows={6} value={JSON.stringify({...challenge,command},null,2)} onFocus={e=>e.target.select()}/></label>
      <label>一次性签名<input autoComplete="off" value={signature} onChange={e=>setSignature(e.target.value)} placeholder="粘贴签名助手输出的签名"/></label>
      <button disabled={busy||!signature.trim()} onClick={()=>void submit()}>确认并执行{action.label}</button>
    </>}
    {message&&<p role="status">{message}</p>}
  </section>
}
