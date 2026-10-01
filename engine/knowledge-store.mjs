import {knowledgeStorage} from './knowledge-storage.mjs';
import {knowledgeCommit} from './knowledge-commit.mjs';
import {patchKnowledgePolicy} from './knowledge-policy.mjs';
import {active,terminal,checkId,clone,digest,fail,assertClaim,advanceJob} from './knowledge-state.mjs';
import {knowledgeReviewStorage} from './knowledge-review.mjs';
import {cultivationHypotheses} from './knowledge-cultivation.mjs';
import {cultivationDecisions} from './knowledge-cultivation-learning.mjs';
const displayState=job=>job.resolution?'resolved':job.state;
const projectJob=job=>job?clone({...job,displayState:displayState(job)}):null;
export function createKnowledgeStore({wsRoot,now=Date.now,leaseMs=90000,fault,runRoot,runStore}) {
  const io=knowledgeStorage(wsRoot), commits=knowledgeCommit(io,now,fault,{runRoot,runStore});
  const getJob=(data,id)=>{const job=data.jobs[checkId(id)];if(!job)fail('job_not_found');return job;};
  const recoverJobs=async data=>{
    let recovered=await commits.recoverJournals(data);
    for(const job of Object.values(data.jobs))if(active.has(job.state)&&job.lease?.expiresAt<=now()){
      job.state='queued';job.lease=null;job.revision++;job.updatedAt=now();recovered++;
    }return recovered;
  };
  return {
    cultivationDecisions:cultivationDecisions({io,now}),
    offerCultivation:cultivationHypotheses({io,now}),
    review:knowledgeReviewStorage({io,now,getJob}),
    async workerState(){return clone(io.readState().worker||{failures:0,cooldownUntil:0});},
    saveWorkerState:state=>io.transaction(data=>{data.worker={failures:state.failures,cooldownUntil:state.cooldownUntil};}),
    async policy(){return clone(io.readState().policy);},
    policyCurrent(revision){return io.readState().policy.revision===revision;},
    // Final synchronous fence: no entry-file scan or await between state check and return.
    retrievalCurrent(entries,policyRevision){
      const data=io.readState();
      return data.policy.revision===policyRevision&&entries.every(entry=>{
        const job=data.jobs[entry.jobId];
        return entry.workspace===data.workspace&&job?.state==='committed'&&job.entryId===entry.id&&
          job.sourceVersion===entry.sourceVersion&&(data.entryStates?.[entry.id]?.status??entry.status)==='active';
      });
    },
    updatePolicy:(patch,revision)=>io.transaction(data=>{
      data.policy=patchKnowledgePolicy(data.policy,patch,revision);
      for(const job of Object.values(data.jobs))if(active.has(job.state)){
        job.state='queued';job.stage='collecting';job.lease=null;job.revision++;job.updatedAt=now();delete job.candidate;delete job.validation;
      }return data.policy;
    }),
    wakeBlocked:reasons=>io.transaction(data=>{
      let count=0;for(const job of Object.values(data.jobs))if(!job.resolution&&job.state==='blocked'&&reasons.includes(job.reason)){
        job.state='queued';job.stage='collecting';job.lease=null;job.revision++;job.updatedAt=now();delete job.reason;delete job.validation;delete job.candidate;count++;
      }return count;
    }),
    invalidateEntry:(entryId,reason)=>io.transaction(data=>{
      checkId(entryId);data.entryStates??={};
      if(!data.entryStates[entryId]?.replacementJobId)data.entryStates[entryId]={status:reason,at:now()};
    }),
    linkReplacement:(entryId,jobId)=>io.transaction(data=>{
      checkId(entryId);getJob(data,jobId);data.entryStates??={};
      data.entryStates[entryId]={...data.entryStates[entryId],status:'superseded',replacementJobId:jobId,at:now()};
    }),
    bindSources:(id,guard,snapshots)=>io.transaction(data=>{
      const job=getJob(data,id);assertClaim(job,guard,data.policy,now());
      if(job.state!=='collecting'||!job.sources.length||job.sources.some(s=>s.kind!=='url'||s.hash))fail('invalid_source_binding');
      job.sources=snapshots.map(s=>clone(s.reference));job.sourceVersion=digest(snapshots.map(s=>[s.locator,s.hash]));job.revision++;return job;
    }),
    enqueue:input=>io.transaction(data=>{
      if(!input||typeof input.sourceId!=='string'||!input.sourceId||input.sourceId.length>2048||! /^[a-f0-9]{64}$/.test(input.sourceVersion)||
        !['completed','failed','manual','correction','gap','review','team'].includes(input.event)||!Array.isArray(input.sources)||input.sources.length>5)fail('invalid_source');
      if(input.expectedPolicyRevision!==undefined&&input.expectedPolicyRevision!==data.policy.revision)fail('revision_conflict');
      if(input.relatedJobId){const parent=getJob(data,input.relatedJobId);
        if(parent.revision!==input.expectedJobRevision)fail('revision_conflict');
        if(parent.resolution)fail('job_resolved');
        if(!['review_required','blocked'].includes(parent.state))fail('invalid_control');}
      const id=digest([data.workspace,input.sourceId,input.sourceVersion,input.event,input.sessionId||'']);
      if(data.jobs[id])return data.jobs[id];
      if(Object.keys(data.jobs).length>=5000)fail('knowledge_storage_full');
      const job={id,workspace:data.workspace,sourceId:input.sourceId,sourceVersion:input.sourceVersion,event:input.event,
        runId:input.runId||null,sessionId:input.sessionId||null,parentRunId:input.parentRunId||null,sources:clone(input.sources),
        focus:String(input.focus||'').slice(0,240),relatedJobId:input.relatedJobId||null,
        title:String(input.title||'知识任务').slice(0,160),state:'queued',stage:'collecting',revision:1,generation:0,
        policyRevision:data.policy.revision,lease:null,attempts:0,createdAt:now(),updatedAt:now()};
      data.jobs[id]=job;return job;
    }),
    async get(id){checkId(id);return projectJob(io.readState().jobs[id]);},
    async getMany(ids){
      if(!Array.isArray(ids)||ids.length>50)fail('invalid_pagination');
      ids.forEach(checkId);const data=io.readState();return ids.map(id=>projectJob(data.jobs[id]));
    },
    block:(id,reason)=>io.transaction(data=>{
      const job=getJob(data,id);if(job.state!=='queued')return job;
      job.state='blocked';job.reason=reason;job.revision++;job.updatedAt=now();return job;
    }),
    async list({offset=0,limit=20}={}){
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)fail('invalid_pagination');
      const jobs=Object.values(io.readState().jobs).sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
      return {items:jobs.slice(offset,offset+limit).map(projectJob),total:jobs.length,offset,limit};
    },
    async summary(){const data=io.readState(),counts={};for(const j of Object.values(data.jobs))counts[displayState(j)]=(counts[displayState(j)]||0)+1;
      return {counts,total:Object.keys(data.jobs).length,policyRevision:data.policy.revision,paused:data.policy.paused};},
    async projection({sessionId,runId}={}){
      const data=io.readState(),counts={};
      const jobs=Object.values(data.jobs).filter(j=>(!sessionId||j.sessionId===sessionId)&&(!runId||j.runId===runId));
      for(const j of jobs)counts[displayState(j)]=(counts[displayState(j)]||0)+1;
      return {counts,total:jobs.length,methodVerified:false,paused:data.policy.paused,
        jobs:sessionId?jobs.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,20).map(j=>({id:j.id,runId:j.runId,sessionId:j.sessionId,
          state:j.state,displayState:displayState(j),resolution:clone(j.resolution||null),stage:j.stage,reason:j.reason||null,entryId:j.entryId||null})):[]};
    },
    supersedeMissingGap:(runId,sessionId,replacementJobId)=>io.transaction(data=>{
      const replacement=getJob(data,replacementJobId);
      if(replacement.runId!==runId||replacement.sessionId!==sessionId||replacement.event!=='gap'||!replacement.sources.length)fail('invalid_source');
      for(const job of Object.values(data.jobs))if(!job.resolution&&job.event==='gap'&&job.runId===runId&&job.sessionId===sessionId&&
        !job.sources.length&&job.state==='blocked'&&job.reason==='source_missing')
        Object.assign(job,{state:'skipped',reason:'source_replaced',replacementJobId,revision:job.revision+1,updatedAt:now()});
    }),
    claim:owner=>io.transaction(async data=>{
      if(typeof owner!=='string'||!owner||owner.length>200)fail('invalid_owner');
      if(data.policy.paused||!data.policy.localEnabled)return null;
      await recoverJobs(data);if(Object.values(data.jobs).some(j=>active.has(j.state)))return null;
      const job=Object.values(data.jobs).find(j=>j.state==='queued'||j.state==='retry_wait'&&j.nextAttemptAt<=now());
      if(!job)return null;
      job.state=active.has(job.stage)?job.stage:'collecting';job.policyRevision=data.policy.revision;job.revision++;job.generation++;
      job.lease={owner,expiresAt:now()+leaseMs};job.updatedAt=now();return job;
    }),
    transition:(id,guard,patch)=>io.transaction(data=>{
      const job=getJob(data,id);assertClaim(job,guard,data.policy,now());
      const updated=advanceJob(job,patch,now());if(updated.lease)updated.lease.expiresAt=now()+leaseMs;
      if(updated.state==='review_required'&&updated.validation?.reason==='source_conflict'){
        data.entryStates??={};
        for(const entryId of updated.validation.conflicts||[]){checkId(entryId);
          if(Object.values(data.jobs).some(j=>j.entryId===entryId&&j.state==='committed'))
            data.entryStates[entryId]={...data.entryStates[entryId],status:'conflict',conflictingJobId:id,at:now()};}
      }
      data.jobs[id]=updated;return updated;
    }),
    control:(id,action,revision)=>io.transaction(data=>{
      if(getJob(data,id).event==='cultivation'&&action!=='cancel')fail('independent_evidence_required');
      const job=getJob(data,id);if(job.revision!==revision)fail('revision_conflict');
      if(job.resolution)fail('job_resolved');
      if(terminal.has(job.state)&&!(job.state==='failed'&&action==='retry')||!['pause','resume','cancel','retry'].includes(action))fail('invalid_control');
      if(action==='resume'&&job.state!=='paused'||action==='retry'&&!['blocked','retry_wait','failed'].includes(job.state))fail('invalid_control');
      if(action==='retry'||action==='resume'){job.stage='collecting';job.attempts=0;delete job.candidate;delete job.validation;delete job.nextAttemptAt;}
      job.state=action==='pause'?'paused':action==='cancel'?'cancelled':'queued';job.reason=null;job.lease=null;job.revision++;job.updatedAt=now();return job;
    }),
    recover:()=>io.transaction(async data=>({recovered:await recoverJobs(data)})),
    commit:commits.commit,entries:commits.entries,
    recordUse:(entryId,feedback)=>io.transaction(data=>{
      checkId(entryId);if(!Object.values(data.jobs).some(j=>j.entryId===entryId&&j.state==='committed'))fail('entry_not_found');
      if(!feedback?.runId||!feedback?.sessionId||feedback.result!=='used')fail('invalid_feedback');
      const file=`usage/${entryId}.json`,usage=io.read(file,{count:0,recent:[]});
      if(!usage.recent.some(r=>r.runId===feedback.runId&&r.sessionId===feedback.sessionId)){
        usage.count++;usage.recent.push({runId:feedback.runId,sessionId:feedback.sessionId,result:'used',at:now()});usage.recent=usage.recent.slice(-100);io.write(file,usage);
      }return usage;
    }),
  };
}
