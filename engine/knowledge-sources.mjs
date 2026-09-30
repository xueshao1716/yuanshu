import fs from 'node:fs';
import path from 'node:path';
import {isProtectedPath} from './tools/security.mjs';
import {reviewStoragePath} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {scopeKey} from './run-recovery.mjs';
import {digest,fail} from './knowledge-state.mjs';
import {knowledgeRunOutput} from './knowledge-run-source.mjs';
const MAX_BYTES=1024*1024;
const privateSegment=/(^|\/)(\.git|\.pi|\.ssh|\.env[^/]*|\.token|auth[^/]*\.json|credentials[^/]*|secrets?[^/]*|config[^/]*|models\.json|genome\.json|proposals\.json|人格[^/]*|关系记忆[^/]*)(\/|$)/i;
export function knowledgeSourcePath(wsRoot,input,roots) {
  if(typeof input!=='string'||!input||input.includes('\0'))fail('source_path_denied');
  const rel=path.relative(path.resolve(wsRoot),path.resolve(wsRoot,input)).replaceAll('\\','/');
  if(!rel||rel.startsWith('../')||path.isAbsolute(rel)||/[\x00-\x1f:]/.test(rel)||privateSegment.test(rel)||
    rel.startsWith('记忆/知识/')||isProtectedPath(path.resolve(wsRoot,rel)))fail('source_path_denied');
  let real;try {real=reviewStoragePath(wsRoot,rel);}catch{fail('source_path_denied');}
  const allowed=roots.some(root=>{
    const abs=path.resolve(wsRoot,root),relative=path.relative(abs,real);
    return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);
  });
  if(!allowed)fail('source_not_authorized');return {real,locator:rel};
}
export async function collectLocalSources({wsRoot,runRoot,sources,policy,runStore,now=Date.now}) {
  if(!policy.localEnabled||policy.paused)fail('source_not_authorized');
  if(!Array.isArray(sources)||!sources.length)fail('source_missing');
  if(sources.length>5)fail('source_limit');
  const snapshots=[];
  const pending=[...sources];
  for(const source of pending){
    let text,locator,kind=source.kind,authority='source';
    if(kind==='run'||kind==='run_result'){
      const run=runStore?.get(source.runId);
      if(!run||run.sessionId!==source.sessionId||scopeKey(run.backgroundRecovery?.scope||'')!==scopeKey(wsRoot)||
        !['completed','failed'].includes(run.status)||run.request?.origin==='knowledge')fail('source_not_authorized');
      if(typeof run.request?.message!=='string'||!run.request.message.trim())fail('source_missing');
      if(kind==='run_result'){
        text=knowledgeRunOutput(runRoot,run,{required:true});locator=`run-result:${run.id}`;authority='model_output';
      }else{
        text=run.request.message;locator=`run:${run.id}`;authority='user_statement';
        if(run.status==='failed'){text+=`\n运行结果：失败（不推断原因）`;authority='failure_observation';}
        if(!source.inputOnly&&pending.length<5&&knowledgeRunOutput(runRoot,run))pending.push({kind:'run_result',runId:run.id,sessionId:run.sessionId});
      }
    }else if(kind==='file'){
      const roots=[...(policy.allowedRoots||[])];
      if(source.runId){const run=runStore?.get(source.runId);
        if(run?.sessionId===source.sessionId&&scopeKey(run.backgroundRecovery?.scope||'')===scopeKey(wsRoot)&&
          ['completed','failed'].includes(run.status)&&run.request?.origin!=='knowledge')
          for(const f of run.request?.files||[])if(typeof f.path==='string'&&typeof source.path==='string'&&path.resolve(wsRoot,f.path)===path.resolve(wsRoot,source.path))roots.push(source.path);
      }
      const target=knowledgeSourcePath(wsRoot,source.path,roots);locator=target.locator;
      try{if(fs.statSync(target.real).size>MAX_BYTES)fail('source_too_large');text=readReviewBounded(target.real,MAX_BYTES).toString('utf8');}
      catch(e){if(e.code==='source_too_large')throw e;fail('source_missing');}
      if(text.includes('\0'))fail('source_format_unsupported');
    }else fail('source_format_unsupported');
    if(Buffer.byteLength(text)>MAX_BYTES)fail('source_too_large');
    const hash=digest(text);if(source.hash&&source.hash!==hash)fail('source_changed');
    snapshots.push({id:digest([locator,hash]),kind,locator,hash,text,authority,reference:{...source,...(kind==='run'?{inputOnly:true}:{}),hash},fetchedAt:now()});
  }return snapshots;
}
