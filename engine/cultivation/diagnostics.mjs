import {id} from './control-state.mjs';
import {policyBlockers,blocker} from './policy-diagnostics.mjs';
import {assertDispatchWindow} from './policy.mjs';
import {LEARNING_SCOPE} from './learning-permissions.mjs';

const actions=['agent.register','agent.adopt','agent.resume','agent.rollback','run.submit','run.dispatch'];
const details=new WeakMap();
export const cultivationFailureDetails=error=>details.get(error)??null;
export const describeFailure=(error,value)=>{details.set(error,value);return error;};
export function createCultivationDiagnostics({controls,execution,verifyAsset,now=Date.now}) {
  const models=async()=>{
    if(!execution?.provider?.inspect)return {models:[],available:false,reason:'catalog_unavailable'};
    try{const state=controls.read(),sharedPolicy=await execution.knowledge.policy();
      const result=await execution.provider.inspect({policy:state.data.policy,sharedPolicy});
      if(controls.read().revision!==state.revision||(await execution.knowledge.policy()).revision!==sharedPolicy.revision)
        return {models:[],available:false,reason:'state_changing'};
      return {models:result.models,available:true,revision:state.revision,health:'not_checked'};
    }catch{return {models:[],available:false,reason:'diagnostics_unavailable'};}
  };
  const preflight=async query=>{
    if(!query||!actions.includes(query.action)||Object.keys(query).some(k=>!['action','designId','agentId'].includes(k))||
      ['designId','agentId'].some(k=>query[k]!==undefined&&!id(query[k])))throw new Error('cultivation_invalid_command');
    if(query.action==='agent.register'?(query.agentId!==undefined||!query.designId):
      !query.agentId||(!['agent.adopt','agent.rollback'].includes(query.action)&&query.designId!==undefined)||
      (['agent.adopt','agent.rollback'].includes(query.action)&&!query.designId))throw new Error('cultivation_invalid_command');
    const state=controls.read(),{data,revision}=state,p=data.policy,run=query.action.startsWith('run.'),dispatch=query.action==='run.dispatch';
    const agent=query.agentId&&data.agents.find(a=>a.id===query.agentId);
    const target=query.designId??agent?.designId,design=data.designs.find(d=>d.id===target)?.design;
    const blockedBy=[],warnings=[],add=(...args)=>blockedBy.push(blocker(...args));
    if(query.action!=='agent.register'&&!agent)add('agent_not_found','agentId','未找到目标个体','读取 agents 获取真实个体编号。');
    if(!design)add('design_not_found','designId','未找到目标设计稿','先读取 designs 或提交真实设计稿。');
    if(agent&&(agent.status==='archived'||run&&agent.status!=='ready'))add('agent_paused','agent.status','个体当前不能执行此操作','核对个体状态，不要反复提交。');
    if(design){
      blockedBy.push(...policyBlockers(p,design.permissions,{execution:run,now:now()}));
      if(design.protectedProposalRefs.length)add('protected_proposal_pending','design.protectedProposalRefs','仍有关联的受保护提案','请先完成相应提案审查。');
      for(const kind of ['appearance','clothing','voice'])if(design[kind].asset){
        let verified=false;try{const result=agent&&verifyAsset?.({agentId:agent.id,kind,...design[kind].asset});
          if(result&&typeof result.then==='function')Promise.resolve(result).catch(()=>{});else verified=result===true;}catch{}
        if(!verified)add('asset_unverified',`design.${kind}.asset`,'绑定资产尚未通过当前个体验证','先核对资产与个体的绑定；描述文字不受影响。');
      }
    }
    if(query.action==='agent.register'&&data.agents.filter(a=>a.status!=='archived').length>=p.maxAgents)
      add('population_limit','policy.maxAgents','现有个体已达到授权数量上限','核对现有个体或由主人调整数量授权。');
    if(run){
      if(!execution)add('executor_unavailable','executor','执行器不可用','检查宿主执行器连接。');
      if(design&&(design.permissions.tools.length||design.permissions.dataScopes.some(s=>s!==LEARNING_SCOPE)))
        add('unsupported_permissions','design.permissions','当前执行器只支持受限文本任务','tools 保持 []，数据仅支持 knowledge:approved-cultivation。');
      try{assertDispatchWindow(p,now());}catch(error){(dispatch?blockedBy:warnings).push(blocker(error.message.replace('cultivation_',''),'policy.schedule','当前不在可执行的运行时段','提交可排队；真正执行前仍需配置并满足运行时段。'));}
      let sharedRevision,sharedRead=false;
      if(execution)try{
        const shared=await execution.knowledge.policy(),usage=await execution.budget.status();
        sharedRevision=shared.revision;sharedRead=true;
        if(!shared.localEnabled||shared.paused)add('shared_policy_disabled','knowledge.localEnabled','共享后台资源已关闭或暂停','请主人核对知识后台开关。');
        if(execution.provider?.inspect){
          if(!shared.remoteEnabled)add('shared_remote_disabled','knowledge.remoteEnabled','共享外部模型调用尚未开启','请主人核对共享外部调用授权。');
          blockedBy.push(...(await execution.provider.inspect({design,policy:p,sharedPolicy:shared})).blockedBy);
        }
        if(usage.modelRequests>=shared.maxModelRequests)add('shared_request_limit','knowledge.maxModelRequests','共享模型次数已达上限','等待额度恢复，或由主人核对共享上限。');
        if(usage.spent+usage.reserved>shared.dailyCost)add('shared_budget_exhausted','knowledge.dailyCost','共享费用已超可用预算','保留未知费用，不自动释放；核对账本。');
        const own=await execution.budget.consumerStatus?.('cultivation');
        if(own&&p.dailyRequests>0&&own.modelRequests>=p.dailyRequests)add('request_limit','policy.dailyRequests','今日培养次数已用尽','等待下一计费日或由主人核对额度。');
        if(own&&(own.spent+own.reserved)*100>p.dailyBudgetCents)add('budget_exhausted','policy.dailyBudgetCents','培养预算已耗尽或被预留','核对培养账本，未知费用不能自动退回。');
      }catch{add('diagnostics_unavailable','resources','当前资源或模型配置无法读取','恢复资源连接后重新检查；这不是可运行或零用量的证明。');}
      if(sharedRead){let latest;try{latest=await execution.knowledge.policy();}catch{add('diagnostics_unavailable','resources','无法核对共享资源版本','恢复连接后重新检查。');}
        if(latest&&latest.revision!==sharedRevision)throw new Error('cultivation_state_changing');}
    }
    if(controls.read().revision!==revision)throw new Error('cultivation_state_changing');
    return {action:query.action,revision,ready:blockedBy.length===0,retryable:false,blockedBy,warnings,
      nextAction:blockedBy[0]?.nextAction??'静态预检通过；提交仍会核验真实身份、版本、设计关系、资源预留与实际费用，不代表已授权或已执行。',
      checkedAt:new Date(now()).toISOString(),scope:'configuration_only'};
  };
  return {preflight,models};
}
