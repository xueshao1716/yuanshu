import { useEffect, useRef, useState } from 'react'
import { ConfirmApi } from '../../api'
import { CultivationApi, type Command, type Challenge, type Overview } from './api'
import { date, errorText } from '../shared'
import {androidBridge,ownerInvoke,ownerError} from './owner'
import {policyReadback} from './policy-readback.mjs'

export type Action = {method:'PUT'|'POST';path:string;payload:unknown;label:string;revision:number}
export default function Authorization({action,owner,sessionId,sessionGrantAvailable,close,refresh}:{action:Action;owner?:Overview['ownerConfirmation'];sessionId:string;sessionGrantAvailable:boolean;close:()=>void;refresh:()=>Promise<unknown>}) {
  const [challenge,setChallenge]=useState<Challenge|null>(null),[command,setCommand]=useState<Command|null>(null)
  const [signature,setSignature]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('')
  const pending=useRef(false),submitted=useRef(false),alive=useRef(true),confirmation=useRef<string|null>(null)
  const submittedCommand=useRef<Command|null>(null)
  const policyAction=action.method==='PUT'&&action.path==='/policy'
  const session=!!sessionGrantAvailable&&action.method==='PUT'&&action.path==='/policy'
  const hello=!session&&owner?.mode==='windows-hello',android=!!androidBridge()
  useEffect(()=>{alive.current=true;return()=>{alive.current=false
    if(confirmation.current)void ConfirmApi.answer(sessionId,confirmation.current,false).catch(()=>{})
  }},[sessionId])
  const reconcile=async()=>{
    const cmd=submittedCommand.current;if(!cmd||!policyAction)return
    try {
      const actual=await CultivationApi.overview();if(!alive.current)return
      const result=policyReadback(cmd,actual)
      if(result.state!=='matched'){
        setMessage(`提交结果尚待核对：${result.message}。本次不会重新提交；可重新核对实际状态。`);return
      }
      setMessage(result.message)
      try{await refresh();if(alive.current)close()}
      catch{if(alive.current)setMessage(`${result.message}，但列表刷新失败。请重新核对；不会再次提交。`)}
    }catch{if(alive.current)setMessage('提交结果尚待核对：未能读取实际状态。请检查连接后重新核对，不要重复提交。')}
  }
  const executeConfirmed=async(cmd:Command,proof:Parameters<typeof CultivationApi.execute>[1],sid?:string)=>{
    submitted.current=true;submittedCommand.current=cmd
    try{await CultivationApi.execute(cmd,proof,sid)}catch(e){if(!policyAction)throw e}
    if(!alive.current)return
    if(policyAction)await reconcile()
    else{await refresh();if(alive.current)close()}
  }
  const recheck=async()=>{
    if(pending.current)return
    pending.current=true;setBusy(true)
    try{await reconcile()}finally{pending.current=false;if(alive.current)setBusy(false)}
  }
  const sessionSubmit=async()=>{
    if(pending.current||submitted.current||!sessionId)return
    pending.current=true;setBusy(true);setMessage('')
    try {
      const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.sessionChallenge(cmd,sessionId);confirmation.current=next.id
      if(!alive.current){await ConfirmApi.answer(sessionId,next.id,false);return}
      const ok=window.confirm(`请确认本次培养操作：${action.label}\n\n${JSON.stringify(action.payload,null,2)}\n\n仅批准以上培养策略；不开放电脑、文件或其他系统权限。`)
      const answered=await ConfirmApi.answer(sessionId,next.id,ok)
      if(!ok){setMessage('已取消本次培养授权，没有提交。');return}
      if(!answered.ok)throw new Error('确认已失效，请刷新后重新核对')
      if(!alive.current)return
      const proof=await CultivationApi.sessionConfirm(next,cmd,sessionId)
      confirmation.current=null
      if(!alive.current)return
      await executeConfirmed(cmd,proof,sessionId)
    }catch(e){if(alive.current)setMessage(submitted.current?`${errorText(e)}。提交结果尚待核对，请刷新记录，不要重复操作。`:`${errorText(e)}。本次确认未提交，请重新核对。`)}
    finally{if(confirmation.current)void ConfirmApi.answer(sessionId,confirmation.current,false).catch(()=>{});confirmation.current=null;pending.current=false;if(alive.current)setBusy(false)}
  }
  const nativeSubmit=async()=>{
    const invoke=ownerInvoke();if(pending.current||submitted.current||!invoke||!owner)return
    pending.current=true;setBusy(true);setMessage('');let stage:'challenge'|'native'|'submit'='challenge'
    try{
      const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.challenge(cmd)
      if(!alive.current)return
      stage='native';const signature=await invoke<string>('owner_confirmation_sign',{workspace:owner.workspace,request:{...next,command:cmd}})
      if(!alive.current)return
      stage='submit';await executeConfirmed(cmd,{id:next.id,signature})
    }catch(e){if(alive.current)setMessage(stage==='submit'?`${errorText(e)}。提交结果尚待核对，请刷新记录，不要重复操作。`:stage==='native'?ownerError(e):errorText(e))}
    finally{pending.current=false;if(alive.current)setBusy(false)}
  }
  const prepare=async()=>{
    if(pending.current||submitted.current)return;pending.current=true
    setBusy(true);setMessage('');setSignature('');setChallenge(null)
    try {const cmd:Command={method:action.method,path:action.path,body:{requestId:crypto.randomUUID(),expectedRevision:action.revision,payload:action.payload}}
      const next=await CultivationApi.challenge(cmd);if(!alive.current)return;setCommand(cmd);setChallenge(next)
    } catch(e){setMessage(errorText(e))} finally{pending.current=false;setBusy(false)}
  }
  const submit=async()=>{
    if(!challenge||!command||pending.current||submitted.current)return
    pending.current=true
    setBusy(true);setMessage('')
    try {await executeConfirmed(command,{id:challenge.id,signature:signature.trim()})
    } catch(e){if(alive.current)setMessage(`${errorText(e)}。请刷新核对结果；签名已作废，不要重复提交。`)}
    finally{pending.current=false;if(alive.current){setChallenge(null);setSignature('');setBusy(false)}}
  }
  return <section className="soul-notice" aria-label="人工授权确认">
    <h4>{action.label}</h4><p>{session?(sessionId?'这是当前会话的一次性培养确认，只绑定这条操作，不会开放电脑、文件或其他系统权限。':'请先选择当前会话。'):hello?(android?'本次不是培养策略操作，仍需原有签名通道。安卓设备凭据尚未绑定，不能在这里代签；培养策略可返回授权与资源使用会话确认。':'请先核对本次操作，接着在 Windows 系统窗口完成本人确认。取消不会提交，确认后自动保存；访问令牌不能代替本人授权。'):'请先核对本次操作。使用你保管的签名密钥批准，访问令牌不能代替本人授权。私钥不要粘贴到网页。'}</p>
    <pre className="cultivation-json">{JSON.stringify({method:action.method,path:action.path,revision:action.revision,payload:action.payload},null,2)}</pre>
    <div className="soul-actions">{session?<button disabled={busy||submitted.current||!sessionId} onClick={()=>void sessionSubmit()}>{busy?'正在确认或核对…':'本次会话确认并执行'}</button>:hello?<button disabled={busy||android||submitted.current||!ownerInvoke()} onClick={()=>void nativeSubmit()}>{busy?'正在确认或核对…':android?'当前会话不可用':'本人确认并执行'}</button>:<button disabled={busy||submitted.current} onClick={()=>void prepare()}>{challenge?'重新生成授权请求':'生成授权请求'}</button>}{submitted.current&&policyAction&&<button disabled={busy} onClick={()=>void recheck()}>重新核对实际状态</button>}<button disabled={busy} onClick={close}>{submitted.current?'关闭并核对记录':'返回，不操作'}</button></div>
    {hello&&!ownerInvoke()&&<p role="status">请在新版 Windows 桌面客户端确认；网页不会代签。</p>}
    {session&&!sessionId&&<p role="status">请先在灵魂培养中心选择当前会话，再进行一次性确认。</p>}
    {challenge&&command&&<>
      <p>请求有效期至 {date(challenge.expiresAt)}。将下方内容交给本机签名助手核对，过期后可重新生成。</p>
      <label>待签名内容<textarea readOnly rows={6} value={JSON.stringify({...challenge,command},null,2)} onFocus={e=>e.target.select()}/></label>
      <label>一次性签名<input autoComplete="off" value={signature} onChange={e=>setSignature(e.target.value)} placeholder="粘贴签名助手输出的签名"/></label>
      <button disabled={busy||!signature.trim()} onClick={()=>void submit()}>确认并执行{action.label}</button>
    </>}
    {message&&<p role="status">{message}</p>}
  </section>
}
