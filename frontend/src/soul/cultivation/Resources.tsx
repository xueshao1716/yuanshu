import { useState } from 'react'
import type { Overview, Policy } from './api'
import type { Action } from './Authorization'
import { date } from '../shared'
export default function Resources({value,onAction}:{value:Overview;onAction:(a:Action)=>void}) {
  const [draft,setDraft]=useState(JSON.stringify(value.policy,null,2)),[error,setError]=useState('')
  const [draftRevision,setDraftRevision]=useState(value.revision),[reason,setReason]=useState('')
  const stale=draftRevision!==value.revision
  const expiry=value.policy.expiresAt?Date.parse(value.policy.expiresAt):NaN
  const policyState=!value.policy.enabled?'未启用':!Number.isFinite(expiry)?'有效期未知':expiry<=Date.now()?'已过期':'已启用'
  const motherState=!value.policy.motherLearning?'未授权':policyState==='已启用'?'已事先授权':`暂不可用（${policyState}）`
  const prepare=()=>{if(stale)return;try{const policy:Policy=JSON.parse(draft);setError('');onAction({method:'PUT',path:'/policy',payload:{policy},revision:draftRevision,label:'更新培养授权'})}catch{setError('设置不是有效的 JSON，请核对括号和数值。')}}
  return <>
    <dl className="soul-facts"><div><dt>培养授权</dt><dd>{policyState}</dd></div><div><dt>到期时间</dt><dd>{date(value.policy.expiresAt)}</dd></div><div><dt>母体自主采用经验</dt><dd>{motherState}</dd></div><div><dt>小语身份通道</dt><dd>{value.motherIdentityAvailable?'已连接':'未连接'}</dd></div><div><dt>人工签名通道</dt><dd>{value.humanGrantAvailable?'已配置':'待主人配置'}</dd></div><div><dt>执行器</dt><dd>{value.executorAvailable?'已连接':'不可用'}</dd></div></dl>
    <p className="soul-hint">培养与知识后台共用资源额度，前台聊天优先。外部请求同时受知识授权与下方培养授权限制；递归繁殖和工具继承不开放。</p>
    {value.usage?<dl className="soul-facts"><div><dt>共享已结算费用</dt><dd>{value.usage.spent} {value.usage.currency}</dd></div><div><dt>已预留费用</dt><dd>{value.usage.reserved} {value.usage.currency}</dd></div><div><dt>用量待确认</dt><dd>{value.usage.unknown}</dd></div></dl>:<p>尚无可读取的资源账本，不按零用量显示。</p>}
    {!value.humanGrantAvailable&&<p className="soul-notice">需要先在服务宿主配置主人持有密钥的公钥。操作指南：docs/cultivation-operations.md。未配置前可观察，不能修改授权。</p>}
    {value.admission?.state==='held'&&<p role="status">后台名额由{value.admission.consumer==='cultivation'?'培养任务':'知识任务'}占用。{value.admission.recoveryRequired?'宿主已确认原进程结束，可核对后恢复名额。':'仍需等待宿主确认结束；不会按超时自动释放。'}</p>}
    {value.admission?.recoveryRequired&&<details><summary>恢复已结束进程占用的名额</summary><p>这只释放本地并发名额，不代表外部请求成功或费用已知；未知费用仍保留。</p><label>恢复理由<input maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label><button disabled={!value.humanGrantAvailable||!reason.trim()} onClick={()=>onAction({method:'POST',path:'/resources/reconcile',payload:{slotId:value.admission!.id,reason:reason.trim()},revision:value.revision,label:'恢复后台名额'})}>核对并申请恢复</button></details>}
    <details><summary>编辑资源与运行时段</summary><p>金额单位为美分；models 填模型管理中的精确标识。启用必须设置 expiresAt（带时区的 ISO 时间，例如 2027-01-01T00:00:00.000Z）和 schedule（时区、星期、起止分钟）。服务器会校验完整设置。</p>
      <p>学习正文只有在授权和个体设计都列入数据范围 knowledge:approved-cultivation 后，才可发给指定模型；默认不分享私人记忆。</p>
      <p>motherLearning 默认关闭。由主人签名开启后，母体可自行采用所属个体有独立来源的经验；每次采用和取用仍核查来源、个体状态与数据授权，不授予人格、基因基线或权限修改权。</p>
      <p>关闭 motherLearning 会停止后续取用自主采用的经验，不删除历史对话；主人逐条批准的分享不受此开关撤销。停用培养授权则停止两类分享。</p>
      <p>当前采用保守校验：授权、设计或个体操作导致控制版本变化后，自主采用的经验需重新核验并采用，不能因重新开启授权而自动恢复。</p>
      {stale&&<p role="alert">设置已更新。当前草稿基于旧版本，请重新载入并核对，避免覆盖新授权。</p>}
      <label>授权设置<textarea rows={18} value={draft} onChange={e=>setDraft(e.target.value)} spellCheck={false}/></label>
      <div className="soul-actions"><button onClick={()=>{setDraft(JSON.stringify(value.policy,null,2));setDraftRevision(value.revision);setError('')}}>重新载入当前设置</button><button disabled={!value.humanGrantAvailable||stale} onClick={prepare}>核对并申请签名</button></div>
      {error&&<p role="alert">{error}</p>}
    </details>
    <p className="soul-hint">aibody 土壤：尚无独立观察结论。模型自评不等于健康评分、用户认可或基因变更依据。</p>
  </>
}
