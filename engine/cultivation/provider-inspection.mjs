import {isTextModel} from '../../shared/model-capabilities.mjs';
import {blocker} from './policy-diagnostics.mjs';
export async function inspectProvider(catalog,{design,policy,sharedPolicy:p}) {
  const models=(await catalog()).filter(isTextModel).map(m=>({key:`${m.provider}/${m.id}`,label:String(m.name||m.id).slice(0,200),
    cultivationAuthorized:policy.models.includes(`${m.provider}/${m.id}`),sharedAuthorized:p.allowedModels.includes(`${m.provider}/${m.id}`),health:'not_checked'}));
  const blockedBy=[],add=(...args)=>blockedBy.push(blocker(...args));
  if(!design)return {models,blockedBy};
  if(!Number.isSafeInteger(p.inputTokens)||p.inputTokens<1||!Number.isSafeInteger(p.outputTokens)||p.outputTokens<1||p.outputTokens>4096)
    add('input_limit','knowledge.inputTokens/outputTokens','共享模型输入或输出上限无效','输入上限须为正整数，输出须为 1–4096；实际输入长度仍在执行前核对。');
  const key=design.permissions.model,rate=p.rates[key];
  if(!models.some(m=>m.key===key))add('model_unavailable','design.permissions.model','设计模型不在当前文本模型目录','使用 models 返回的精确标识（提供方/模型）；目录存在不代表探活成功。');
  if(!design.permissions.remote||!policy.allowRemote)add('remote_required','design.permissions.remote','HTTP 模型需要明确的外部请求授权','先由主人核对外部授权，再在授权范围内修订 remote 标记。');
  if(!p.allowedModels.includes(key))add('model_not_authorized','knowledge.allowedModels','共享模型白名单尚未包含设计模型','请主人在知识资源配置核对共享模型白名单。');
  if(!rate||![rate.input,rate.output].every(n=>Number.isFinite(n)&&n>=0)||rate.input===0&&rate.output===0&&rate.free!==true)
    add('price_unknown','knowledge.rates','模型价格缺失或未明确标记免费','核对输入/输出单价；零价须明确 free=true。');
  if(rate&&rate.currency!==p.currency||p.currency!=='USD')add('currency_mismatch','knowledge.currency','共享账本币种与模型价格不一致','培养账本使用 USD，请核对币种。');
  if(rate&&rate.tokenBound!=='utf8-bytes')add('token_bound_unknown','knowledge.rates.tokenBound','未配置保守输入计费边界','请核对该模型的 utf8-bytes 计费边界。');
  if(rate&&!(rate.input===0&&rate.output===0&&rate.free===true)&&policy.dailyBudgetCents===0)
    add('budget_exhausted','policy.dailyBudgetCents','每日培养预算为零，无法付费运行','请主人核对预算，或选用已明确配置的免费模型。');
  return {models,blockedBy};
}
