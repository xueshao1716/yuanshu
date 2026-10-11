const quiet=new Set(['cultivation_identity_denied','cultivation_identity_unavailable',
  'cultivation_identity_expired','cultivation_policy_changed',
  // 2026-10-11：还没培养经验是常态不是故障（真机：任务轮每转都"暂不可用"只能徒增唠叨）
  'cultivation_context_unavailable','cultivation_learning_denied']);
const unavailable='培养经验暂不可用，本次对话仍可继续。';
// 授权未开时她的经验确实拿不到：这句话要说清楚，并给出一条她自己就能走通的路。
const policyOff='小语现在读不到她的培养经验：培养授权还没开启。对她说"开启培养"，她就能自己打开受限封套（纯文本、零工具、有上限），经验会接着流进来。';

// Host-only: identity is an in-memory execution capability, never a bearer or session ID.
export async function cultivationChatContext(runtime,knowledge,input,note=()=>{}){
  const scope={runId:input.runId,sessionId:input.sessionId};
  const offer=ids=>knowledge.offerCultivationReferences(scope,ids);
  try{
    if(!input.executionIdentity){offer([]);return '';}
    const result=await boundedKnowledgeContext(signal=>runtime.readMother({action:'learning.context',payload:{
      query:typeof input.query==='string'?input.query.slice(0,1000):''}},input.executionIdentity,{signal}),input);
    if(result.available===false)throw new Error('cultivation_context_unavailable');
    offer(result.context?result.entries.map(e=>e.id):[]);
    return result.context||'';
  }catch(error){
    try{offer([]);}catch{}
    if(!input.signal?.aborted&&!quiet.has(error?.message)&&error?.message!=='cultivation_policy_disabled')try{note(unavailable);}catch{}
    if(!input.signal?.aborted&&error?.message==='cultivation_policy_disabled')try{note(policyOff);}catch{}
    return '';
  }
}
import {boundedKnowledgeContext} from '../knowledge-context-deadline.mjs';
