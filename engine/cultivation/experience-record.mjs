import {digest} from '../knowledge-state.mjs';

// Record execution outcomes, not imagined lessons or private provider errors.
export function experienceRecord(run){
  const c=run?.cultivation;
  if(!c)return null;
  if(run.status==='completed'){
    if(typeof c.output!=='string'||!c.output.trim()||c.output.length>16000)return null;
    return {role:'model_generated',text:c.output,hash:digest(c.output)};
  }
  if(!['failed','stopped','interrupted'].includes(run.status))return null;
  const outcome=run.status==='interrupted'?'unknown':run.status==='failed'?'failed':
    ['cancelled','cancel_requested'].includes(c.reason)?'cancelled':'not_completed';
  const descriptions={unknown:'任务被中断，实际结果未知；不能判为成功或失败。',
    failed:'任务执行失败；原因尚未独立核验。',cancelled:'任务已取消；未据此推断任务质量。',
    not_completed:'任务未完成；没有已确认的输出或失败结论。'};
  return {role:'execution_record',outcome,text:descriptions[outcome],
    hash:digest({status:run.status,reason:c.reason??null,output:c.output??null})};
}
