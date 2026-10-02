import {describeFailure} from './diagnostics.mjs';
import {designValidationDetails} from './designs.mjs';
import {blocker} from './policy-diagnostics.mjs';

const denied=new Set(['invalid_command','invalid_payload','invalid_design','invalid_policy','revision_conflict','idempotency_conflict',
  'identity_denied','identity_expired','policy_disabled','policy_expired','request_denied','permission_expansion','population_limit',
  'protected_proposal_pending','asset_unverified','design_lineage','design_not_found','agent_not_found','agent_paused',
  'invalid_transition','executor_unavailable','unsupported_permissions','independent_evidence_required','data_not_authorized']);
export function createFailureReporting({history,controls,diagnostics}) {
  return async(error,command,actor)=>{
    const code=String(error?.message??'').replace(/^cultivation_/, '');
    if(!denied.has(code))return error;
    // Storage/initialization errors may be post-commit, not rejected commands.
    try{if(controls.read().data.receipts.some(r=>r.id===command.requestId&&r.commandHash===actor.commandHash))return error;}catch{return error;}
    let report=null;
    if(['agent.register','agent.adopt','agent.resume','agent.rollback','run.submit'].includes(command.action)){
      try{const query={action:command.action};for(const key of ['agentId','designId'])if(command.payload?.[key])query[key]=command.payload[key];
        report=await diagnostics.preflight(query);}catch{}
    }
    let audit;try{audit=await history.record(command,actor,error.message);}catch{audit={recorded:false,reason:'audit_unavailable'};}
    const validation=designValidationDetails(error);
    const nextAction=code==='permission_expansion'?'本次修订扩大权限，不能自行批准；文本执行器使用 tools=[]。请核对现有授权，不要重复原请求。':
      code==='revision_conflict'?'状态已更新，重新读取当前版本并核对后再提交新请求。':
      validation?'按 field 和 expected 修正格式后，重新读取版本并使用新 requestId。':
      report?.nextAction??'此请求未获接受。核对当前状态和操作权限；不要重复原请求或伪造批准。';
    const blockedBy=report?.blockedBy??[];
    if(!blockedBy.some(b=>b.code===error.message))blockedBy.unshift(blocker(code,validation?.field??'command','本次操作未通过校验',nextAction));
    return describeFailure(error,{...validation,error:error.message,retryable:false,blockedBy,nextAction,audit,
      ...(report?{revision:report.revision,checkedAt:report.checkedAt}:{} )});
  };
}
