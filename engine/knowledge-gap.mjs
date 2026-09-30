import fs from 'node:fs';
import path from 'node:path';
import {digest} from './knowledge-state.mjs';
import {knowledgeSourcePath,collectLocalSources} from './knowledge-sources.mjs';

// Called only by terminal-run intake, never on the foreground retrieval path.
export async function enqueueKnowledgeGap({run,wsRoot,runRoot,runStore,store}){
  if(!run.knowledgeGap||run.knowledgeGap.sessionId!==run.sessionId)return;
  const policy=await store.policy(),sources=[];
  for(const file of (run.request?.files||[]).slice(0,5))if(typeof file.path==='string')
    sources.push({kind:'file',path:file.path,runId:run.id,sessionId:run.sessionId});
  // Read a bounded, nonrecursive selection of explicitly authorized roots.
  if(!sources.length)for(const root of policy.allowedRoots.slice(0,5)){
    try{const target=knowledgeSourcePath(wsRoot,root,policy.allowedRoots);
      if(fs.statSync(target.real).isFile())sources.push({kind:'file',path:root});
      else{const dir=await fs.promises.opendir(target.real);let scanned=0;
        try{for await(const item of dir){if(++scanned>20||sources.length>=5)break;
          if(item.isFile()&&/\.(md|txt|json|csv)$/i.test(item.name))sources.push({kind:'file',path:path.join(root,item.name)});}}
        finally{try{await dir.close();}catch{}}
      }
    }catch{/* Unavailable roots are not authorization to scan elsewhere. */}
    if(sources.length>=5)break;
  }
  if(!sources.length&&policy.networkEnabled)for(const url of policy.allowedUrls.slice(0,5))sources.push({kind:'url',url});
  if(!sources.length){const job=await store.enqueue({sourceId:`gap:${run.id}`,sourceVersion:digest([run.id,'no_sources']),
    event:'gap',runId:run.id,sessionId:run.sessionId,focus:run.knowledgeGap.focus,sources:[],title:'知识缺口等待获准资料'});
    await store.block(job.id,'source_missing');return;}
  for(const source of sources){
    let snapshots,reason;
    if(source.kind!=='url')try{snapshots=await collectLocalSources({wsRoot,runRoot,runStore,sources:[source],policy});}
    catch(e){reason=e.code||'source_missing';}
    const job=await store.enqueue({sourceId:`gap:${run.id}:${source.path||source.url}`,
      sourceVersion:snapshots?digest(snapshots.map(s=>[s.locator,s.hash])):digest([source,'requested']),
      event:'gap',runId:run.id,sessionId:run.sessionId,focus:run.knowledgeGap.focus,sources:[source],title:'知识缺口的获准来源'});
    if(reason)await store.block(job.id,reason);
    else await store.supersedeMissingGap(run.id,run.sessionId,job.id);
  }
}
