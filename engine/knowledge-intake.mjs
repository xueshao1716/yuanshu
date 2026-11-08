import fs from 'node:fs';
import path from 'node:path';
import {knowledgeStorage} from './knowledge-storage.mjs';
import {collectLocalSources} from './knowledge-sources.mjs';
import {reviewStoragePath} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {inWorkspace} from './learning-intake.mjs';
import {digest,fail} from './knowledge-state.mjs';
import {enqueueKnowledgeGap} from './knowledge-gap.mjs';

// No network or model work in intake. Only terminal ledger records are authoritative.
export function createKnowledgeIntake({wsRoot,runRoot,runStore,store}){
  const io=knowledgeStorage(wsRoot);let directory=null,lastError=null,legacyRetired=0,reconciling=null;
  const eligible=run=>run&&['completed','failed'].includes(run.status)&&inWorkspace(run,wsRoot)&&!['knowledge','cultivation'].includes(run.request?.origin);
  const sourcePolicy=p=>digest([p.localEnabled,p.allowedRoots,p.networkEnabled,p.allowedUrls]);
  async function enqueueRun(input){
    const run=runStore.get(input?.id);if(!eligible(run))return null;
    const policy=await store.policy();
    await enqueueKnowledgeGap({run,wsRoot,runRoot,runStore,store});
    const sources=[{kind:'run',runId:run.id,sessionId:run.sessionId}];
    let snapshots,reason;
    try{snapshots=await collectLocalSources({wsRoot,runRoot,sources,policy:await store.policy(),runStore});}
    catch(e){reason=e.code||'source_missing';}
    const sourceVersion=snapshots?digest(snapshots.map(s=>[s.locator,s.hash])):digest([run.id,run.status,run.request||null,'missing']);
    const job=await store.enqueue({sourceId:`run:${run.id}`,sourceVersion,event:run.status,runId:run.id,sessionId:run.sessionId,sources,title:run.status==='failed'?'失败任务观察':'任务来源资料'});
    if(reason)await store.block(job.id,reason);
    runStore.update(run.id,{knowledgeIntake:{jobId:job.id,sourceVersion,sourcePolicy:sourcePolicy(policy)}});return job;
  }
  async function migrate(limit){
    return io.transaction(async()=>{
      const progress=io.read('migration.json',{v:1,offset:0,done:false,legacyRetired:0});legacyRetired=progress.legacyRetired;
      if(progress.done)return {entries:[],offset:progress.offset,done:true};
      let old=io.read('legacy-intake-backup.json');
      if(!old){
        let raw;try{raw=readReviewBounded(reviewStoragePath(wsRoot,'记忆/运行时/待提炼任务.json'),4*1024*1024).toString('utf8');}
        catch(e){if(e.code==='ENOENT'){progress.done=true;io.write('migration.json',progress);return {entries:[],offset:progress.offset,done:true};}throw e;}
        try{old=JSON.parse(raw);}catch{fail('legacy_state_unreadable');}
        if(old.v!==1||!Array.isArray(old.entries))fail('legacy_state_unreadable');
        // Exclusive creation preserves the byte-for-byte original, including legacy formatting.
        const backup=io.file('legacy-intake-backup.json');fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(backup,raw,{flag:'wx'});
      }
      legacyRetired=Number(old.retired)||0;
      return {entries:old.entries.slice(progress.offset,progress.offset+limit),offset:progress.offset,total:old.entries.length};
    });
  }
  async function reconcile({limit=20}={}){
    if(reconciling)return reconciling;
    reconciling=(async()=>{
      let scanned=0;limit=Math.max(1,Math.min(20,limit));
      try{
        const legacy=await migrate(limit);
        for(const [index,entry] of legacy.entries.entries()){
          const run=runStore.get(entry.runId);
          if(eligible(run)&&run.sessionId===entry.sessionId)await enqueueRun(run);
          else {
            const job=await store.enqueue({sourceId:`legacy:${entry.runId}`,sourceVersion:digest([entry.runId,entry.sessionId,'missing']),event:'completed',runId:entry.runId,sessionId:entry.sessionId,sources:[],title:'旧来源待补齐'});
            await store.block(job.id,'source_missing');
          }
          // Acknowledge the actual index, not a blind increment: concurrent scans may overlap.
          await io.transaction(()=>{const p=io.read('migration.json',{v:1,offset:0});
            if(p.offset===legacy.offset+index)p.offset++;
            p.legacyRetired=legacyRetired;p.done=p.offset>=legacy.total;io.write('migration.json',p);});
          scanned++;await new Promise(r=>setImmediate(r));
        }
        if(scanned<limit){
          const policyKey=sourcePolicy(await store.policy());
          if(!directory)try{directory=await fs.promises.opendir(reviewStoragePath(runRoot,'runs'));}catch(e){if(e.code!=='ENOENT')throw e;}
          while(directory&&scanned<limit){
            const entry=await directory.read();if(!entry){await directory.close();directory=null;break;}
            scanned++;if(entry.isFile()&&/^[a-zA-Z0-9_-]+\.json$/.test(entry.name)){
              const run=runStore.get(entry.name.slice(0,-5));
              if(eligible(run)&&(!run.knowledgeIntake||run.knowledgeGap&&run.knowledgeIntake.sourcePolicy!==policyKey))await enqueueRun(run);
            }await new Promise(r=>setImmediate(r));
          }
        }
        lastError=null;return {scanned};
      }catch(e){lastError=/^[a-z_]+$/.test(e.code||'')?e.code:'intake_unavailable';return {scanned,error:lastError};}
    })();try{return await reconciling;}finally{reconciling=null;}
  }
  return {enqueueRun,reconcile,status:()=>({lastError,legacyRetired}),async close(){if(directory){await directory.close();directory=null;}}};
}
