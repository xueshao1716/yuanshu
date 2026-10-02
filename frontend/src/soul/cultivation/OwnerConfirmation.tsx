import {useRef,useState} from 'react'
import type {Overview} from './api'
import {androidBridge,nativeOwner,ownerError,ownerInvoke,type OwnerStatus} from './owner'

export default function OwnerConfirmation({value,refresh}:{value:Overview;refresh:()=>Promise<unknown>}){
  const [status,setStatus]=useState<OwnerStatus|null>(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  const pending=useRef(false),invoke=ownerInvoke(),android=!!androidBridge(),workspace=value.ownerConfirmation?.workspace
  const check=async(pair=false)=>{
    if(pending.current||!invoke||!workspace)return
    pending.current=true;setBusy(true);setMessage('')
    try{
      if(pair)await invoke('owner_confirmation_pair',{workspace})
      setStatus(await invoke<OwnerStatus>('owner_confirmation_status',{workspace}))
      if(pair){setMessage('本机确认方式已设置，正在读取服务状态；尚未开启学习。');await refresh()}
    }catch(e){setMessage(ownerError(e))}finally{pending.current=false;setBusy(false)}
  }
  return <section aria-label="主人确认方式">
    <h4>{android?'安卓设备确认':'主人确认'}</h4>
    <p>你决定她可以学什么、学多久。设置本人确认方式不会开启学习；每次变更都要先核对范围。</p>
    {nativeOwner(value)?<>
      <p>{android?'当前在安卓客户端。培养策略可直接使用上方会话确认，无需 Windows 配对。个体回退、资源恢复等其他人工操作仍需原有签名通道，可在受信任的 Windows 客户端配对，或使用外部签名方式。':value.ownerConfirmation?.state==='locked'?'本机凭据发生变化，确认通道已锁定。请核查后重启服务，不会自动替换主人。':value.humanGrantAvailable?'本机已配对。核对操作后，使用 Windows Hello 确认即可自动提交。':'首次使用需在这台电脑设置 Windows Hello 本人确认，不用管理或粘贴密钥。'}</p>
      {android?<p className="soul-notice">安卓端暂不执行需要主人签名的培养写入，避免把“生物识别成功”误当成服务端授权。查看记录和外部签名流程仍可用。</p>:!invoke?<p className="soul-notice">请使用新版 Windows 桌面客户端连接本机工作台。网页和旧客户端仍可查看记录，但不提供本机配对。</p>:<div className="soul-actions">
        <button disabled={busy} onClick={()=>void check()}>{busy?'正在等待系统确认…':'检查本机确认方式'}</button>
        {status?.available&&!status.paired&&value.ownerConfirmation?.state!=='locked'&&<button disabled={busy} onClick={()=>void check(true)}>设置本人确认</button>}
      </div>}
      {status&&!status.available&&<p role="status">Windows Hello 尚不可用。请打开 Windows 设置 → 账户 → 登录选项，设置 PIN 或指纹后重新检查。</p>}
      {status?.paired&&!value.humanGrantAvailable&&<p role="status">客户端已有凭据，服务尚未就绪。请刷新；若仍未连接，请核查服务与客户端是否使用同一个 Windows 账户。</p>}
    </>:<p>{value.humanGrantAvailable?'已配置独立签名方式。':'服务尚未配置本人确认方式；可以查看记录，不能修改授权。'}</p>}
    <details><summary>高级签名与恢复说明</summary><p>保留外部签名助手与公钥配置，适用于非 Windows 宿主。已有外部签名配置优先，不会自动改成 Hello。操作说明：docs/cultivation-operations.md。私钥不要粘贴到网页。丢失凭据需要本人在宿主重新核查，不提供自动重置。</p></details>
    {message&&<p role="status">{message}</p>}
  </section>
}
