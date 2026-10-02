// Shared by enforcement and preflight. Messages contain no submitted values.
export const blocker=(code,field,message,nextAction)=>({code:`cultivation_${code}`,field,message,nextAction});
export function policyBlockers(p,request,{execution=true,now=Date.now()}={}) {
  const rows=[],add=(...args)=>rows.push(blocker(...args));
  if(!p.enabled)add('policy_disabled','policy.enabled','培养授权尚未开启','请主人在授权与资源中核对并会话确认；草稿可保留。');
  if(!Number.isFinite(now)||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now)
    add('policy_expired','policy.expiresAt','缺少有效的培养授权期限','请主人核对有效期，不要自行续期。');
  if(!request||!p.models.includes(request.model))add('request_denied','policy.models','设计模型未列入培养授权','从 models 读取精确模型标识；请主人核对模型白名单。');
  for(const field of ['tools','dataScopes'])if(!Array.isArray(request?.[field])||request[field].length>64||
    new Set(request[field]).size!==request[field].length||Array.from(request[field]).some(v=>typeof v!=='string'||!v||v.trim()!==v||v.length>200||!p[field].includes(v)))
    add('request_denied',`policy.${field}`,'设计请求超出授权范围',field==='tools'?'当前文本执行器使用 tools=[]，不要添加工具。':'请主人核对数据范围；不自动扩权。');
  if(typeof request?.remote!=='boolean'||request.remote&&!p.allowRemote)
    add('request_denied','policy.allowRemote','外部模型请求未获授权','请主人核对是否允许外部请求。');
  if(!Number.isSafeInteger(request?.costUpperBoundCents)||request.costUpperBoundCents<0)
    add('request_denied','design.permissions.costUpperBoundCents','单次费用上限格式无效','填写非负整数，单位为美分。');
  else if(execution&&request.costUpperBoundCents>p.dailyBudgetCents)
    add('request_denied','policy.dailyBudgetCents','设计单次费用上限超过每日培养预算','核对设计单次上限与主人批准的每日预算；零预算可登记但不能付费运行。');
  if(execution&&p.dailyRequests===0)add('request_denied','policy.dailyRequests','每日运行次数上限为零','可以登记个体；执行前需主人核对运行次数。');
  return rows;
}
