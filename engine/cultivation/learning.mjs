import {exact,id} from './control-state.mjs';
import {clonePayload} from './state.mjs';
import {learningAllowed} from './learning-permissions.mjs';
const fail=code=>{throw new Error(`cultivation_${code}`);};
export function validateLearningCommand(c){
  if(!exact(c,['action','requestId','expectedRevision','payload'])||!id(c.requestId)||
    !Number.isSafeInteger(c.expectedRevision)||c.expectedRevision<0||c.action!=='learning.decide'||
    !exact(c.payload,['jobId','scope','decision','reason'])||!/^[a-f0-9]{64}$/.test(c.payload.jobId)||
    !(c.payload.scope==='mother'||id(c.payload.scope))||!['adopt','retire'].includes(c.payload.decision)||
    typeof c.payload.reason!=='string'||!c.payload.reason.trim()||c.payload.reason.length>1000)fail('invalid_command');
}
export function createLearningCommands({authority,controls,learning,getJob,now=Date.now}){
  return async(input,principal)=>{
    const c=clonePayload(input);validateLearningCommand(c);
    if(!learning||!getJob)fail('executor_unavailable');
    const kinds=['human','mother'];
    authority.assert(principal,c,kinds);
    const job=await getJob(c.payload.jobId);
    let revision;
    const guard=()=>{
      const actor=authority.assert(principal,c,kinds),state=controls.read();
      if(actor.kind==='mother'&&c.payload.scope==='mother'){
        if(!state.data.policy.motherLearning)fail('identity_denied');
        if(revision!==undefined&&revision!==state.revision)fail('policy_changed');
      }
      const agent=state.data.agents.find(a=>a.id===job?.provenance?.agentId);
      if(!agent||c.payload.scope!=='mother'&&c.payload.scope!==agent.id||
        actor.kind==='mother'&&agent.mentorId!==actor.actorId)fail('identity_denied');
      if(c.payload.decision==='adopt'&&(!state.data.policy.enabled||
        Date.parse(state.data.policy.expiresAt)<=now()||agent.status!=='ready'))fail('policy_disabled');
      const design=state.data.designs.find(d=>d.id===agent.designId)?.design;
      if(c.payload.decision==='adopt'&&!learningAllowed(state.data.policy,design))fail('data_not_authorized');
      return actor;
    };
    const actor=guard();
    revision=controls.read().revision;
    const motherAuthorization=actor.kind==='mother'&&c.payload.scope==='mother'?{mode:'policy',revision}:undefined;
    try{return await learning.decide({...c.payload,expectedRevision:c.expectedRevision,requestId:c.requestId},actor,{guard,motherAuthorization});}
    catch(error){if(error.code)fail(error.code);throw error;}
  };
}
