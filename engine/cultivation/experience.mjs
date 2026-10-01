import {digest} from '../knowledge-state.mjs';
import {experienceObservation} from './experience-observation.mjs';
import {experienceRecord} from './experience-record.mjs';

export function createCultivationExperience({repo,knowledge,workspace,now=Date.now}) {
  return Object.freeze({
    async reconcile(){
      for await(const run of repo.scan())if(experienceRecord(run)&&!run.cultivation.knowledgeJobId){
        // Deterministic knowledge ID survives a second-file receipt failure.
        const job=await knowledge.offerCultivation(run);
        const current=repo.get(run.id);
        if(!current||current.cultivation?.knowledgeJobId||experienceRecord(current)?.hash!==experienceRecord(run)?.hash)continue;
        repo.update(run.id,{cultivation:{...current.cultivation,knowledgeJobId:job.id}});
      }
    },
    async list(query){
      const page=repo.page(query,{collection:'experience',filter:r=>r.cultivation.knowledgeJobId});
      const jobs=await knowledge.getMany(page.items.map(r=>r.cultivation.knowledgeJobId));
      const items=[];
      for(const [index,run] of page.items.entries()){
        const job=jobs[index];
        const record=experienceRecord(run);
        const valid=job?.runId===run.id&&job.provenance?.outputHash===(record?.hash??
          (run.status===undefined?digest(run.cultivation.output):null));
        items.push({id:run.id,agentId:run.cultivation.agentId,knowledgeJobId:run.cultivation.knowledgeJobId,
          state:valid?(job.resolution?'resolved':job.state):'invalidated',
          reason:valid?job.reason:'source_unavailable',evidenceCount:0,userAcceptance:null,
          revision:valid?job.revision:null,learning:valid?job.learning??[]:[],
          role:record?.role??'model_generated',...(record?.outcome?{outcome:record.outcome}:{}),resolution:valid?job.resolution??null:null,
          observation:experienceObservation(run,valid?job:null)});
      }
      return {...page,items,supported:true,coverage:{basis:'returned_page',
        returnedCount:items.length,hasMore:page.nextCursor!==null,observedAt:now()}};
    },
  });
}
