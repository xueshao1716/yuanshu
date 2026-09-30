import {reviewStoragePath} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {resolveTeamAcceptance} from './team-acceptance.mjs';
import {inWorkspace} from './learning-intake.mjs';

// Read on explicit detail requests only. Never approve, scan every run, or expose review text.
export function createKnowledgeProvenance({wsRoot,runStore,taskEvidence}){
  return job=>{
    const empty=status=>({status,task:null,teams:[],methodVerified:false});
    if(!job.runId)return empty('not_applicable');
    const run=runStore.get(job.runId);
    if(!run||run.sessionId!==job.sessionId||!inWorkspace(run,wsRoot))return empty('unavailable');
    try{
      const evidence=taskEvidence.get(run.id);
      if(evidence.runId!==run.id||evidence.sessionId!==run.sessionId)return empty('unavailable');
      const paths=[...job.sources,...evidence.artifacts].map(s=>String(s.path||'').replaceAll('\\','/'));
      const ids=new Set(paths.map(p=>p.match(/^工程\/多AI角色扮演系统\/runs\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,100})\//)?.[1]).filter(Boolean));
      const teams=[];
      for(const id of [...ids].slice(0,5))try{
        const file=reviewStoragePath(wsRoot,`工程/多AI角色扮演系统/runs/${id}/evolution-evidence.json`);
        const team=JSON.parse(readReviewBounded(file,1024*1024));
        if(team.runId!==id||team.mode!=='real'||team.parentRunId!==run.id||team.sessionId!==run.sessionId)continue;
        const c=team.checklist;
        teams.push({runId:id,parentRunId:run.id,sessionId:run.sessionId,
          modelReview:Number.isSafeInteger(c?.total)&&c.total>0&&c.total===c.passed&&c.failed===0?'PASS':'UNVERIFIED',
          acceptance:resolveTeamAcceptance({wsRoot,run:team})?.status||'unknown'});
      }catch{/* Missing or mismatched evidence grants no authority. */}
      return {status:'available',methodVerified:false,teams,task:{runId:run.id,sessionId:run.sessionId,status:run.status,
        acceptance:evidence.acceptance,objective:evidence.objective?.status||'UNVERIFIED',
        reviewRevision:evidence.review?.revision||null}};
    }catch{return empty('unavailable');}
  };
}
