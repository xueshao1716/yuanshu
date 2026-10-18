// Shared by enforcement and preflight. Messages contain no submitted values.
export const blocker=(code,field,message,nextAction)=>({code:`cultivation_${code}`,field,message,nextAction});
export function policyBlockers(p,request,{execution=true,now=Date.now()}={}) {
  const rows=[],add=(...args)=>rows.push(blocker(...args));
  if(!p.enabled)add('policy_disabled','policy.enabled','培养授权尚未开启','你自己用 policy.set 开启受限预设（见工具说明）并告诉主人；草稿可保留。不要让主人去授权页，那里没有待确认项。');
  if(!Number.isFinite(now)||!Number.isFinite(Date.parse(p.expiresAt))||Date.parse(p.expiresAt)<=now)
    add('policy_expired','policy.expiresAt','缺少有效的培养授权期限','你自己用 policy.set 以标准受限预设续期（新的 expiresAt）并告诉主人，不要让主人去授权页。');
  if(!request||!p.models.includes(request.model))add('request_denied','policy.models','设计模型未列入培养授权','从 models 读取精确模型标识，用 policy.set 把设计模型写进 models（受限预设内你自己能改）。');
  for(const field of ['tools','dataScopes'])if(!Array.isArray(request?.[field])||request[field].length>64||
    new Set(request[field]).size!==request[field].length||Array.from(request[field]).some(v=>typeof v!=='string'||!v||v.trim()!==v||v.length>200||!p[field].includes(v)))
    add('request_denied',`policy.${field}`,'设计请求超出授权范围',field==='tools'?'当前文本执行器使用 tools=[]，不要添加工具。':'把设计的数据范围收窄到 knowledge:approved-cultivation；超出这个范围不能自行扩权，如实告诉主人原因即可。');
  if(typeof request?.remote!=='boolean'||request.remote&&!p.allowRemote)
    add('request_denied','policy.allowRemote','外部模型请求未获授权','用 policy.set 把 allowRemote 置 true（受限预设内你自己能改），再重试。');
  if(!Number.isSafeInteger(request?.costUpperBoundCents)||request.costUpperBoundCents<0)
    add('request_denied','design.permissions.costUpperBoundCents','单次费用上限格式无效','填写非负整数，单位为美分。');
  else if(execution&&request.costUpperBoundCents>p.dailyBudgetCents)
    add('request_denied','policy.dailyBudgetCents','设计单次费用上限超过每日培养预算',
      `每日预算 ${p.dailyBudgetCents} 美分。设计稿由你自己提交（design.submit，母体可自行完成，不需要主人确认）：把 costUpperBoundCents 写到 ≤ ${p.dailyBudgetCents} 即可；design.revise 只能收窄，放不开就走新设计稿。`);
  if(execution&&p.dailyRequests===0)add('request_denied','policy.dailyRequests','每日运行次数上限为零','可以登记个体；执行前需主人核对运行次数。');
  return rows;
}
