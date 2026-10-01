import {digest,fail} from './knowledge-state.mjs';
import {id} from './cultivation/control-state.mjs';
import {experienceRecord} from './cultivation/experience-record.mjs';

// Host-only intake, not an HTTP source type. Generated output has zero
// independent evidence and can never be claimed by the extraction worker.
export function cultivationHypotheses({io,now}) {
  return run=>io.transaction(data=>{
    const c=run?.cultivation,record=experienceRecord(run);
    if(!record||run.request?.origin!=='cultivation'||!id(run.id)||
      !c||c.workspace!==data.workspace||!id(c.agentId)||!id(c.designId))fail('invalid_source');
    const sourceVersion=record.hash,sourceId=`cultivation:${run.id}`;
    const key=digest([data.workspace,sourceId,sourceVersion]);
    if(data.jobs[key])return data.jobs[key];
    if(Object.keys(data.jobs).length>=5000)fail('knowledge_storage_full');
    const job={id:key,workspace:data.workspace,sourceId,sourceVersion,event:'cultivation',
      runId:run.id,sessionId:run.sessionId,parentRunId:null,sources:[],focus:'',
      title:'培养任务的待核验经验',state:'review_required',stage:'validating',
      reason:'independent_evidence_required',revision:1,generation:0,policyRevision:data.policy.revision,
      lease:null,attempts:0,createdAt:now(),updatedAt:now(),
      candidate:{kind:'synthesis',text:record.text,scope:record.role==='model_generated'?'模型生成的假设，未经独立核验':'执行结果记录，不是已核验的知识'},
      provenance:{role:record.role,...(record.outcome?{outcome:record.outcome}:{}),agentId:c.agentId,designId:c.designId,runId:run.id,
        outputHash:sourceVersion,lineage:[sourceId],independentEvidenceCount:0,userAcceptance:null}};
    data.jobs[key]=job;return job;
  });
}
