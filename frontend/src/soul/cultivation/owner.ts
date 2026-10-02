import type {Overview} from './api'
type Invoke=<T>(command:string,args?:Record<string,unknown>)=>Promise<T>
export const ownerInvoke=():Invoke|undefined=>(globalThis as unknown as {__TAURI__?:{core?:{invoke?:Invoke}}}).__TAURI__?.core?.invoke
type AndroidBridge={canAuthenticate?:()=>boolean;authenticate?:()=>void}
export const androidBridge=():AndroidBridge|undefined=>(globalThis as unknown as {YuanshuBridge?:AndroidBridge}).YuanshuBridge
export type OwnerStatus={available:boolean;paired:boolean}
export const ownerError=(error:unknown)=>{
  const code=String(error)
  const messages:Record<string,string>={HELLO_UNAVAILABLE:'这台电脑尚未启用 Windows Hello。请在 Windows 设置 → 账户 → 登录选项中设置 PIN 或指纹，再重新检查。',OWNER_CANCELLED:'本人验证已取消或超时，没有提交授权。',OWNER_BUSY:'已有本人确认正在进行，请先完成或取消系统窗口。',OWNER_EXISTS:'本机已经配对，不会覆盖现有主人凭据。请刷新状态。',OWNER_EXPIRED:'请求已过期。请重新核对并确认。',OWNER_ORIGIN:'请从桌面客户端的本机工作台进行确认。',OWNER_INVALID:'请求或本机凭据未通过校验，没有提交授权。',OWNER_STORAGE:'无法安全读取或保存本机凭据，请检查本机应用数据目录。'}
  return messages[code]||'桌面确认不可用。请更新桌面客户端后重试；本次未获得本人签名。'
}
export const nativeOwner=(value?:Overview)=>value?.ownerConfirmation?.mode==='windows-hello'
