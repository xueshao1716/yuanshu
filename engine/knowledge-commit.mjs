import fs from 'node:fs';
import {assertClaim,checkId,clone,digest,fail} from './knowledge-state.mjs';
import {collectLocalSources} from './knowledge-sources.mjs';
export function knowledgeCommit(storage,now,fault=()=>{},sourceContext={}) {
  function finish(data,journal) {
    const job=data.jobs[journal.jobId];
    if(!job||job.state!=='ready'||job.revision!==journal.revision||job.generation!==journal.generation||
      job.sourceVersion!==journal.sourceVersion||data.policy.revision!==journal.policyRevision||
      !data.policy.localEnabled||data.policy.paused)return false;
    if(job.approval&&job.relatedJobId&&data.jobs[job.relatedJobId]?.revision!==job.approval.parentRevision)return false;
    if(digest(journal.entry)!==journal.hash||journal.entry.sourceVersion!==job.sourceVersion)fail('knowledge_journal_invalid');
    const existing=storage.read(`entries/${journal.entry.id}.json`);
    if(existing&&digest(existing)!==journal.hash)fail('knowledge_journal_invalid');
    if(!existing)storage.write(`entries/${journal.entry.id}.json`,journal.entry);
    data.jobs[job.id]={...job,state:'committed',stage:'committed',lease:null,revision:job.revision+1,entryId:journal.entry.id,updatedAt:now()};
    if(job.approval?.decision==='accept_source'){
      data.entryStates??={};for(const entryId of job.approval.conflicts||[])data.entryStates[entryId]={...data.entryStates[entryId],
        status:'superseded',replacementJobId:job.id,reviewedByJobId:job.id,at:now()};
      const parent=data.jobs[job.relatedJobId];if(parent&&parent.revision===job.approval.parentRevision){
        parent.resolution={jobId:job.id,entryId:journal.entry.id,at:now()};parent.revision++;parent.updatedAt=now();
      }
    }
    return true;
  }
  return {
    commit:(id,guard,entry)=>storage.transaction(data=>{
      checkId(id);const job=data.jobs[id];if(!job)fail('job_not_found');assertClaim(job,guard,data.policy,now());
      if(job.state!=='ready'||entry.sourceVersion!==job.sourceVersion)fail('invalid_commit');
      if(job.approval&&job.relatedJobId&&data.jobs[job.relatedJobId]?.revision!==job.approval.parentRevision)fail('review_parent_changed');
      const entryId=digest([data.workspace,job.id,job.sourceVersion]);
      const saved={...clone(entry),id:entryId,jobId:id,workspace:data.workspace,createdAt:now()};
      const journal={jobId:id,revision:job.revision,generation:job.generation,policyRevision:data.policy.revision,
        sourceVersion:job.sourceVersion,entry:saved,hash:digest(saved)};
      storage.write(`journal/${id}.json`,journal);fault('afterIntent');
      storage.write(`entries/${entryId}.json`,saved);fault('afterEntry');
      if(!finish(data,journal))fail('invalid_commit');return data.jobs[id];
    }),
    async recoverJournals(data) {
      let names;try{names=fs.readdirSync(storage.file('journal'));}catch(e){if(e.code==='ENOENT')return 0;throw e;}
      let recovered=0;
      for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
        if(data.jobs[name.slice(0,-5)]?.state!=='ready')continue;
        await new Promise(resolve=>setImmediate(resolve));
        const journal=storage.read(`journal/${name}`);if(journal?.jobId!==name.slice(0,-5))fail('knowledge_journal_invalid');
        const job=data.jobs[journal.jobId];
        if(!job||job.state!=='ready'||job.revision!==journal.revision||job.generation!==journal.generation||data.policy.revision!==journal.policyRevision)continue;
        // Recovery never trusts a previous source check and never fetches under the store lock.
        // URL commits return to the worker for authorized, budgeted revalidation.
        if(job.sources.some(s=>['url','method'].includes(s.kind))){
          Object.assign(job,{state:'queued',stage:'collecting',lease:null,revision:job.revision+1,updatedAt:now()});
          delete job.candidate;delete job.validation;recovered++;continue;
        }
        try{
          const snapshots=await collectLocalSources({wsRoot:storage.root,...sourceContext,sources:job.sources,policy:data.policy,now});
          if(digest(snapshots.map(s=>[s.locator,s.hash]))!==job.sourceVersion)fail('source_changed');
        }catch(e){
          Object.assign(job,{state:'blocked',stage:'collecting',reason:/^source_[a-z_]+$/.test(e.code||'')?e.code:'source_unavailable',lease:null,revision:job.revision+1,updatedAt:now()});
          recovered++;continue;
        }
        if(finish(data,journal))recovered++;
      }return recovered;
    },
    async entries({offset=0,limit=5000}={}) {
      const data=storage.readState();const result=[];
      for(const job of Object.values(data.jobs).filter(j=>j.state==='committed').slice(offset,offset+limit)){
        await new Promise(resolve=>setImmediate(resolve));
        const entry=storage.read(`entries/${checkId(job.entryId)}.json`);
        if(!entry||entry.jobId!==job.id||entry.sourceVersion!==job.sourceVersion)fail('knowledge_state_unreadable');
        const journal=storage.read(`journal/${job.id}.json`);
        if(!journal||journal.hash!==digest(entry)||journal.entry.id!==entry.id)fail('knowledge_journal_invalid');
        result.push({...entry,...data.entryStates?.[entry.id]});
      }
      // Yielding is cooperative, never permission caching: read current status again.
      const current=storage.readState();
      return clone(result.filter(e=>current.jobs[e.jobId]?.state==='committed').map(e=>({...e,...current.entryStates?.[e.id]})));
    },
  };
}
