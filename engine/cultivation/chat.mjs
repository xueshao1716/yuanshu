const quiet=new Set(['cultivation_identity_denied','cultivation_identity_unavailable',
  'cultivation_identity_expired','cultivation_policy_disabled','cultivation_policy_changed']);
const unavailable='培养经验暂不可用，本次对话仍可继续。';

// Host-only: identity is an in-memory execution capability, never a bearer or session ID.
export async function cultivationChatContext(runtime,knowledge,input,note=()=>{}){
  const scope={runId:input.runId,sessionId:input.sessionId};
  const offer=ids=>knowledge.offerCultivationReferences(scope,ids);
  try{
    if(!input.executionIdentity){offer([]);return '';}
    const result=await runtime.readMother({action:'learning.context',payload:{
      query:typeof input.query==='string'?input.query.slice(0,1000):''}},input.executionIdentity);
    if(result.available===false)throw new Error('cultivation_context_unavailable');
    offer(result.context?result.entries.map(e=>e.id):[]);
    return result.context||'';
  }catch(error){
    try{offer([]);}catch{}
    if(!quiet.has(error?.message))try{note(unavailable);}catch{}
    return '';
  }
}
