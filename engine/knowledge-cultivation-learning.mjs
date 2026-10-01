import {checkId,clone,fail,digest} from './knowledge-state.mjs';

// Decisions reference independently committed knowledge; they never promote
// the generated hypothesis to fact or write personality / gene state.
export function cultivationDecisions({io,now}) {
  return {
    read(scope){
      const result=[];
      for(const job of Object.values(io.readState().jobs))if(job.event==='cultivation'){
        const decision=job.learning?.filter(row=>row.scope===scope).at(-1);
        if(decision?.decision==='adopt')result.push({jobId:job.id,revision:job.revision,
          agentId:job.provenance.agentId,...clone(decision)});
      }
      return result;
    },
    decide:(input,actor,entry,{guard=()=>actor,policyRevision,verifySource=async()=>false}={})=>io.transaction(async data=>{
      const authenticated=guard();if(digest(authenticated)!==digest(actor))fail('identity_denied');
      const {jobId,scope,decision,reason,expectedRevision}=input;checkId(jobId);
      const job=data.jobs[jobId];if(job?.event!=='cultivation')fail('job_not_found');
      if(input.requestId){
        const prior=job.learning?.find(row=>row.requestId===input.requestId);
        if(prior){if(digest(prior.actor)!==digest(actor)||prior.commandDigest!==digest(input))fail('idempotency_conflict');return job;}
      }
      if(job.revision!==expectedRevision)fail('revision_conflict');
      if(!['mother',job.provenance.agentId].includes(scope)||!['adopt','retire'].includes(decision)||
        typeof reason!=='string'||!reason.trim()||reason.length>1000)fail('invalid_control');
      if(!actor||!['human','mother'].includes(actor.kind)||actor.workspace!==data.workspace||!actor.actorId)fail('identity_denied');
      const previous=job.learning?.filter(row=>row.scope===scope).at(-1);
      if(decision==='adopt'){
        if(data.policy.revision!==policyRevision)fail('policy_changed');
        const source=entry&&data.jobs[entry.jobId];
        if(!entry||job.resolution?.entryId!==entry.id||source?.relatedJobId!==job.id||source?.state!=='committed'||
          source.entryId!==entry.id||source.sourceVersion!==entry.sourceVersion||entry.workspace!==data.workspace||entry.expiresAt<=now()||
          (data.entryStates?.[entry.id]?.status??entry.status)!=='active'||
          !await verifySource(entry,data.policy))fail('independent_evidence_required');
      }else if(previous?.decision!=='adopt')fail('invalid_control');
      if(digest(guard())!==digest(actor))fail('identity_denied');
      job.learning??=[];if(job.learning.length>=128)fail('knowledge_storage_full');
      job.learning.push({scope,decision,reason,version:(previous?.version??0)+1,entryId:entry?.id??previous.entryId,
        ...(input.requestId?{requestId:input.requestId,commandDigest:digest(input)}:{}),
        sourceVersion:entry?.sourceVersion??previous.sourceVersion,actor:clone(actor),at:now(),
        validation:decision==='adopt'?'independent_source_current':'retired_by_actor'});
      job.revision++;job.updatedAt=now();return job;
    }),
  };
}

export function createCultivationLearning({store,retrieval,verifySource}) {
  const context=async({scope,query,maxTokens=2000,agentIds})=>{
    const policy=await store.policy();
    const selected=()=>store.cultivationDecisions.read(scope).filter(d=>
      scope!=='mother'||Array.isArray(agentIds)&&agentIds.includes(d.agentId)&&d.actor.kind==='human').slice(-5);
    const decisions=selected(),entries=[];
    let context='';
    for(const decision of decisions){
      const result=await retrieval.retrieve({query,sessionId:`cultivation:${decision.agentId}`,
        entryIds:[decision.entryId],maxEntries:1,maxTokens:Math.max(0,maxTokens-Buffer.byteLength(context))});
      entries.push(...result.entries);context+=result.context;
    }
    const current=selected();
    if(digest(current)!==digest(decisions)||!store.retrievalCurrent(entries,policy.revision))return {available:false,entries:[],context:''};
    return {available:true,entries,context};
  };
  return {context,async decide(input,actor,options){
    let entry;const policy=await store.policy();
    if(input.decision==='adopt'){
      const job=await store.get(input.jobId);
      if(!job?.resolution)fail('independent_evidence_required');
      const result=await retrieval.retrieve({query:'',sessionId:`cultivation:${job.provenance.agentId}`,
        entryIds:[job.resolution.entryId],maxEntries:1});
      entry=result.entries[0];if(!entry)fail('independent_evidence_required');
    }
    return store.cultivationDecisions.decide(input,actor,entry,{...options,policyRevision:policy.revision,verifySource});
  }};
}
