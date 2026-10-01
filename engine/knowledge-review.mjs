import {digest,fail,clone,checkId} from './knowledge-state.mjs';
import {validateCandidate} from './knowledge-evidence.mjs';
export function knowledgeReviewStorage({io,now,getJob}){
  return (id,decision,revision,policyRevision)=>io.transaction(data=>{
    const job=getJob(data,id);if(job.revision!==revision||data.policy.revision!==policyRevision)fail('revision_conflict');
    if(job.event==='cultivation'&&decision?.decision!=='reject')fail('independent_evidence_required');
    if(job.resolution)fail('job_resolved');
    if(job.state!=='review_required'||data.policy.paused||!data.policy.localEnabled)fail('invalid_control');
    if(!decision||!['accept_source','keep_existing','reject'].includes(decision.decision)||decision.confirmed!==true||
      typeof decision.note!=='string'||!decision.note.trim()||decision.note.length>1000)fail('invalid_review');
    const review={decision:decision.decision,note:decision.note.trim(),source:'authenticated_ui',at:now(),
      sourceVersion:job.sourceVersion,candidateHash:digest(job.candidate),policyRevision,
      conflicts:clone(decision.conflicts||[]),parentRevision:decision.parentRevision||null,selectedEntryId:decision.selectedEntryId||null};
    if(job.relatedJobId){const parent=getJob(data,job.relatedJobId);
      if(parent.resolution)fail('job_resolved');
      if(parent.revision!==review.parentRevision)fail('revision_conflict');}
    for(const entryId of review.conflicts)checkId(entryId);
    job.reviews??=[];if(job.reviews.length>=50)fail('review_history_full');job.reviews.push(review);
    job.approval=review;job.lease=null;job.generation++;job.revision++;job.updatedAt=now();
    if(decision.decision==='reject'){job.state='skipped';job.reason='human_rejected';delete job.approval;}
    else if(decision.decision==='keep_existing'){
      const chosen=checkId(decision.selectedEntryId);if(!review.conflicts.includes(chosen))fail('review_not_eligible');
      data.entryStates??={};for(const entryId of review.conflicts)data.entryStates[entryId]={...data.entryStates[entryId],
        status:entryId===chosen?'active':'superseded',reviewedByJobId:id,at:now()};
      job.state='skipped';job.reason='existing_source_selected';delete job.approval;
    }else {job.state='queued';job.stage='validating';job.reason='human_reviewed_source';}
    return job;
  });
}
export function createKnowledgeReview({store,collect,worker,retrieval,now=Date.now}){
  return async(id,body,revision,policyRevision)=>{
    const job=await store.get(id),policy=await store.policy();if(!job)fail('job_not_found');
    if(job.revision!==revision||policy.revision!==policyRevision)fail('revision_conflict');
    if(job.resolution)fail('job_resolved');
    if(job.state!=='review_required')fail('invalid_control');
    if(!body||body.confirmed!==true||typeof body.note!=='string'||!body.note.trim())fail('invalid_review');
    const decision={decision:body.decision,note:body.note,confirmed:true};
    const parent=job.relatedJobId?await store.get(job.relatedJobId):null;
    if(parent?.resolution)fail('job_resolved');
    if(parent)decision.parentRevision=parent.revision;
    if(body.decision!=='reject'){
      const snapshots=await collect({job,policy});
      if(digest(snapshots.map(s=>[s.locator,s.hash]))!==job.sourceVersion)fail('source_changed');
      // Human choice cannot manufacture exact evidence or bypass injection/method gates.
      const validation=validateCandidate({candidate:job.candidate,snapshots,job:{...job,event:'manual',approval:null},entries:[],now:now()});
      if(validation.state!=='ready'||!['source','observation'].includes(validation.entry.kind))fail('review_not_eligible');
      const entries=await store.entries(),key=validation.entry.claimKey;
      const conflicts=entries.filter(e=>key&&e.claimKey===key&&['active','conflict'].includes(e.status)&&e.claimValue!==validation.entry.claimValue);
      decision.conflicts=[...new Set([...conflicts.map(e=>e.id),...(job.validation?.conflicts||[]),...(parent?.validation?.conflicts||[])])];
      for(const entryId of decision.conflicts){
        const entry=entries.find(e=>e.id===entryId);if(!entry)fail('review_not_eligible');
        if(body.decision==='keep_existing'&&entryId===body.selectedEntryId){
          const sources=await collect({job:{sources:entry.sources.map(s=>s.reference)},policy});
          if(!sources.every(s=>entry.sources.some(e=>e.hash===s.hash&&e.locator===s.locator)))fail('source_changed');
          decision.selectedEntryId=entryId;
        }
      }
      if(body.decision==='keep_existing'&&!decision.selectedEntryId)fail('review_not_eligible');
    }
    const result=await store.review(id,decision,revision,policyRevision);worker.interrupt();await retrieval.refresh();return result;
  };
}
