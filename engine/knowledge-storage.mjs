import fs from 'node:fs';
import path from 'node:path';
import {withCrossProcessLock} from './file-lock.mjs';
import {reviewStoragePath,reviewAtomicWrite} from './review-file-safety.mjs';
import {readReviewBounded} from './review-read.mjs';
import {defaultKnowledgePolicy} from './knowledge-policy.mjs';
import {clone,digest,fail,states,validId} from './knowledge-state.mjs';
export function knowledgeStorage(wsRoot) {
  const root=fs.realpathSync(wsRoot);
  if(fs.lstatSync(wsRoot).isSymbolicLink()) fail('knowledge_path_denied');
  const workspace=digest(process.platform==='win32'?root.toLowerCase():root);
  const file=rel=>reviewStoragePath(root,`记忆/知识/${rel}`);
  const read=(rel,fallback=null)=>{
    try {return JSON.parse(readReviewBounded(file(rel),8*1024*1024));}
    catch(e){if(e.code==='ENOENT')return clone(fallback);fail('knowledge_state_unreadable');}
  };
  const write=(rel,value)=>{
    const text=JSON.stringify(value);if(Buffer.byteLength(text)>8*1024*1024)fail('knowledge_storage_full');
    reviewAtomicWrite(file(rel),text);
  };
  const readState=()=>{
    const data=read('state.json',{v:1,workspace,policy:defaultKnowledgePolicy(),jobs:{}});
    if(data.v!==1||data.workspace!==workspace||!data.policy||!Number.isInteger(data.policy.revision)||
      !data.jobs||Array.isArray(data.jobs))fail('knowledge_state_unreadable');
    for(const [id,j] of Object.entries(data.jobs)) if(!validId(id)||j.id!==id||j.workspace!==workspace||
      !states.has(j.state)||!Number.isInteger(j.revision)||!Number.isInteger(j.generation))fail('knowledge_state_unreadable');
    return data;
  };
  const transaction=work=>withCrossProcessLock(file('state.json'),async()=>{
    const data=readState(),before=JSON.stringify(data);const result=await work(data);
    if(JSON.stringify(data)!==before)write('state.json',data);return clone(result);
  });
  return {root,workspace,file,read,write,readState,transaction};
}
