import {createKnowledgeStore} from './knowledge-store.mjs';
import {createKnowledgeBudget} from './knowledge-budget.mjs';
import {createBackgroundAdmission} from './background-admission.mjs';
import {createKnowledgeWorker} from './knowledge-worker.mjs';
import {createKnowledgeIntake} from './knowledge-intake.mjs';
import {createKnowledgeRetrieval} from './knowledge-retrieval.mjs';
import {createKnowledgeProvider} from './knowledge-provider.mjs';
import {collectLocalSources} from './knowledge-sources.mjs';
import {extractLocal,validateCandidate} from './knowledge-evidence.mjs';
import {knowledgeRunOutput} from './knowledge-run-source.mjs';
import {patchKnowledgePolicy} from './knowledge-policy.mjs';
import {fetchKnowledgeSource,authorizedUrl} from './knowledge-fetch.mjs';
import {isTextModel} from '../shared/model-capabilities.mjs';
import {digest,fail} from './knowledge-state.mjs';
import {createKnowledgeMaintenance,knowledgePolicyWakeReasons} from './knowledge-maintenance.mjs';
import {inWorkspace} from './learning-intake.mjs';
import {createTaskEvidence} from './task-evidence.mjs';
import {createKnowledgeProvenance} from './knowledge-provenance.mjs';
import {createKnowledgeReview} from './knowledge-review.mjs';
import {createKnowledgeMethods} from './knowledge-method.mjs';
import {createCultivationLearning} from './knowledge-cultivation-learning.mjs';

// Composition only: no personality, genome, tool executor or team approval capability.
export function createKnowledgeRuntime({wsRoot,runRoot,runStore,catalog,directChat,foregroundBusy=()=>false,now=Date.now,network={}}){
  const store=createKnowledgeStore({wsRoot,runRoot,runStore,now}),budget=createKnowledgeBudget({wsRoot,now});
  const admission=createBackgroundAdmission({wsRoot,foregroundBusy,now});
  const intake=createKnowledgeIntake({wsRoot,runRoot,runStore,store});
  const provider=createKnowledgeProvider({wsRoot,catalog,directChat,budget});
  const taskEvidence=createTaskEvidence({wsRoot,rootDir:runRoot});
  const provenance=createKnowledgeProvenance({wsRoot,runStore,taskEvidence});
  const methods=createKnowledgeMethods({wsRoot,runRoot,runStore,taskEvidence,now});
  let lastError=null,started=false,work=Promise.resolve();
  const collect=async({job,policy,signal})=>{
    if(job.sources.some(s=>s.kind==='method'))return methods.collect({job,policy});
    if(job.sources.length&&job.sources.every(s=>s.kind==='url')){
      if(job.sources.length>5)fail('source_limit');const snapshots=[];
      for(const s of job.sources){const snapshot=await fetchKnowledgeSource({...network,url:s.url,policy,budget,signal,now});
        if(s.hash&&snapshot.hash!==s.hash)fail('source_changed');snapshots.push(snapshot);}
      return snapshots;
    }
    return collectLocalSources({wsRoot,runRoot,runStore,sources:job.sources,policy,now});
  };
  const verifySource=async(entry,policy)=>{
    try{
      if(entry.kind==='method'){
        if(!methods.sameEnvironment(entry.method))return false;
        const job=await store.get(entry.jobId),snapshots=await collect({job,policy});
        if(digest(snapshots.map(s=>[s.locator,s.hash]))!==job.sourceVersion)return false;
        const proof=methods.verify({candidate:job.candidate,snapshots,job});
        return proof?.ok===true&&digest(proof.method)===digest(entry.method);
      }
      if(entry.sources.every(s=>s.reference.kind==='url'))return policy.localEnabled&&!policy.paused&&policy.networkEnabled&&
        entry.sources.every(s=>{authorizedUrl(s.reference.url,policy);return now()-s.fetchedAt<86400000;});
      const sources=await collect({job:{sources:entry.sources.map(s=>s.reference)},policy});
      return sources.length===entry.sources.length&&sources.every(s=>entry.sources.some(e=>e.locator===s.locator&&e.hash===s.hash));
    }catch{return false;}
  };
  const retrieval=createKnowledgeRetrieval({store,now,verifySource});
  const maintenance=createKnowledgeMaintenance({wsRoot,store,budget,collect,now});
  const worker=createKnowledgeWorker({store,collect,now,foregroundBusy,admission,
    extract:(snapshots,job,{policy,signal})=>job.sources[0]?.kind==='method'?methods.candidate(snapshots):policy.remoteEnabled&&snapshots.every(s=>s.kind==='file')
      ?provider.extract({snapshots,job,policy,signal}):extractLocal(snapshots,job),
    validate:input=>validateCandidate({...input,methodProof:input.candidate?.kind==='method'?methods.verify(input):null}),
    reconcile:async options=>{await intake.reconcile({limit:20});await maintenance.reconcile(options);await retrieval.refresh();},onSettled:()=>retrieval.refresh()});
  const onRunFinished=async input=>{
    try{
      const run=runStore.get(input.id);
      if(!run||!['completed','failed'].includes(run.status)||['knowledge','cultivation'].includes(run.request?.origin))return;
      const references=[run.knowledgeReferences,run.cultivationReferences].filter(r=>r?.sessionId===run.sessionId);
      if(references.length){
        const text=knowledgeRunOutput(runRoot,run);
        for(const id of new Set(references.flatMap(r=>r.ids||[])))if(text.includes(`[知识:${id}]`))
          await store.recordUse(id,{runId:run.id,sessionId:run.sessionId,result:'used'});
      }
      await intake.enqueueRun(run);lastError=null;if(started)worker.wake('run_finished');
    }catch(e){lastError=/^[a-z_]+$/.test(e.code||'')?e.code:'intake_unavailable';}
  };
  return {store,budget,admission,worker,intake,retrieval,onRunFinished,
    cultivationLearning:createCultivationLearning({store,retrieval,verifySource}),
    review:createKnowledgeReview({store,collect,worker,retrieval,now}),
    async detail(id){const job=await store.get(id);if(!job)return null;
      const reviewOptions=job.validation?.conflicts?.length?(await store.entries()).filter(e=>job.validation.conflicts.includes(e.id))
        .map(e=>({id:e.id,text:e.text,sources:e.sources.map(s=>({locator:s.locator}))})):[];
      return {...job,reviewOptions,cultivationProvenance:job.event==='cultivation'?job.provenance:null,provenance:provenance(job)};},
    projection:input=>store.projection(input),
    async status(){return {summary:await store.summary(),budget:await budget.status(),admission:await admission.status(),worker:worker.status(),intake:intake.status(),lastError};},
    async models(){return (await catalog()).filter(isTextModel).map(m=>({key:`${m.provider}/${m.id}`,label:m.name||m.id}));},
    async updatePolicy(patch,revision){
      const previous=await store.policy(),proposed=patchKnowledgePolicy(previous,patch,revision);
      if(proposed.model||proposed.allowedModels.length){const valid=new Set((await catalog()).filter(isTextModel).map(m=>`${m.provider}/${m.id}`));
        if(proposed.model&&!valid.has(proposed.model)||proposed.allowedModels.some(m=>!valid.has(m)))fail('model_not_authorized');}
      const policy=await store.updatePolicy(patch,revision);worker.interrupt();
      await store.wakeBlocked(knowledgePolicyWakeReasons(previous,policy));
      await retrieval.refresh();
      if(started)worker.wake('policy_changed');return policy;
    },
    async enqueue(source,revision,relationship={}){
      const policy=await store.policy();if(policy.revision!==revision)fail('revision_conflict');
      if(source?.kind==='url'){
        const url=authorizedUrl(source.url,policy).href;
        const job=await store.enqueue({sourceId:url,sourceVersion:digest(['url',url,'requested']),sources:[{kind:'url',url}],event:'manual',title:'获准网页资料',expectedPolicyRevision:revision,...relationship});
        if(started)worker.wake('manual');return job;
      }
      if(!source||!['file','run','method'].includes(source.kind))fail('invalid_source');
      const safe=source.kind==='file'?{kind:'file',path:source.path}:source.kind==='method'
        ?{kind:'method',path:source.path,runId:source.runId,sessionId:source.sessionId}:{kind:'run',runId:source.runId,sessionId:source.sessionId};
      const snapshots=await collect({job:{sources:[safe]},policy});
      const job=await store.enqueue({sourceId:safe.kind==='method'?`method:${safe.runId}:${safe.path}`:snapshots[0].locator,sourceVersion:digest(snapshots.map(s=>[s.locator,s.hash])),
        sources:[safe],event:'manual',runId:safe.runId,sessionId:safe.sessionId,title:'手动提交的来源资料',expectedPolicyRevision:revision,...relationship});
      if(started)worker.wake('manual');return job;
    },
    async supplement(id,source,revision,policyRevision){
      const parent=await store.get(id);if(!parent)fail('job_not_found');
      if(parent.revision!==revision)fail('revision_conflict');
      if(parent.resolution)fail('job_resolved');
      return this.enqueue(source,policyRevision,{event:'correction',relatedJobId:id,expectedJobRevision:revision,
        sourceId:`correction:${id}:${digest(source)}`,sessionId:parent.sessionId,runId:parent.runId,title:'原任务补充证据（仍需复核）'});
    },
    async control(id,action,revision){const job=await store.control(id,action,revision);worker.interrupt();if(started)worker.wake('control');return job;},
    offerCultivationReferences({runId,sessionId},ids){
      const run=runStore.get(runId);
      if(!run||run.sessionId!==sessionId||!inWorkspace(run,wsRoot)||
        ['knowledge','cultivation'].includes(run.request?.origin)||!['queued','running'].includes(run.status))return;
      const safe=[...new Set(ids.filter(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)))].slice(0,5);
      runStore.update(run.id,{cultivationReferences:{sessionId,ids:safe}});
    },
    async context(input){
      if(input.signal?.aborted||input.runId&&['knowledge','cultivation'].includes(runStore.get(input.runId)?.request?.origin))
        return {available:false,entries:[],context:''};
      const result=await retrieval.retrieve(input);
      if(input.signal?.aborted)return {available:false,entries:[],context:''};
      // Record what this specific run was offered; merely offering it is not use feedback.
      if(result.entries.length&&input.runId){const run=runStore.get(input.runId);
        if(run?.sessionId===input.sessionId)runStore.update(run.id,{knowledgeReferences:{sessionId:input.sessionId,ids:result.entries.map(e=>e.id)}});}
      else if(result.available&&input.runId){const run=runStore.get(input.runId);
        if(run?.sessionId===input.sessionId&&inWorkspace(run,wsRoot)&&!['knowledge','cultivation'].includes(run.request?.origin)&&run.request?.message?.trim())
          runStore.update(run.id,{knowledgeGap:{sessionId:run.sessionId,focus:run.request.message.trim().slice(0,240)}});}
      return result;
    },
    enqueueFinished(run){
      // Keep disk and extraction off the foreground completion callback.
      work=work.then(()=>new Promise(r=>setImmediate(r))).then(()=>onRunFinished(run)).catch(()=>{lastError='intake_unavailable';});
    },
    start(options){if(started)return;started=true;worker.start(options);void retrieval.refresh();},
    async close(){started=false;await worker.stop();await work;await intake.close();},
  };
}
