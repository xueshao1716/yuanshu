import fs from 'node:fs';
import {createRunStore} from '../run-store.mjs';
import {reviewStoragePath} from '../review-file-safety.mjs';
import {readReviewBounded} from '../review-read.mjs';
import {withCrossProcessLock} from '../file-lock.mjs';
import {id} from './control-state.mjs';
import {pageRecords} from './pagination.mjs';

// Separate task namespace: generic chat recovery never receives these records.
// Reuse the existing task record/lifecycle rather than inventing success states.
export function createCultivationTaskRepository({wsRoot,workspace,now=Date.now}) {
  const root=reviewStoragePath(wsRoot,'工程/智能体培养/tasks');
  const native=createRunStore({rootDir:root,now:()=>new Date(now()).toISOString()});
  const location=key=>{
    if(!id(key))throw new Error('cultivation_invalid_scope');
    return reviewStoragePath(wsRoot,`工程/智能体培养/tasks/runs/${key}.json`);
  };
  let cache=null,fingerprint=null;
  const get=key=>{
      const file=location(key);let raw;
      try{raw=readReviewBounded(file,256*1024);}catch(error){if(error.code==='ENOENT')return null;throw error;}
      const r=JSON.parse(raw);
      if(!id(r.id)||r.id!==key||!r.cultivation||r.cultivation.workspace!==workspace||r.request?.origin!=='cultivation'||
        !id(r.cultivation.agentId)||!id(r.cultivation.designId)||!id(r.clientRequestId)||r.motherIdentityEligible!==false||
        r.sessionId!==`cultivation:${r.cultivation.agentId}`||r.request.sessionId!==r.sessionId||
        !Number.isSafeInteger(r.cultivation.policyRevision)||r.cultivation.policyRevision<1||
        r.cultivation.actor?.kind!=='mother'||r.cultivation.actor.workspace!==workspace||
        typeof r.request.message!=='string'||r.request.message.length>4000||
        typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||
        r.resumeAvailable!==false||!['queued','running','stopping','completed','failed','stopped','interrupted'].includes(r.status))
        throw new Error('cultivation_state_unreadable');
      return r;
  };
  const directoryVersion=()=>{
    const s=fs.statSync(reviewStoragePath(wsRoot,'工程/智能体培养/tasks/runs'),{bigint:true});
    return `${s.ino}:${s.mtimeNs}:${s.ctimeNs}`;
  };
  const list=()=>{
    const dir=reviewStoragePath(wsRoot,'工程/智能体培养/tasks/runs'),version=directoryVersion();
    const names=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort();
    if(names.length>256)throw new Error('cultivation_storage_full');
    cache=null;
    const rows=names.map(n=>get(n.slice(0,-5)));
    if(rows.some(r=>!r))throw new Error('cultivation_state_unreadable');
    cache=rows;fingerprint=version;return structuredClone(rows);
  };
  async function* scan(){
    // Background scans yield between bounded reads. Never cache authority: each
    // record is validated after yielding, immediately before it is consumed.
    const dir=reviewStoragePath(wsRoot,'工程/智能体培养/tasks/runs');
    const names=fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort();
    if(names.length>256)throw new Error('cultivation_storage_full');
    for(const name of names){
      await new Promise(resolve=>setImmediate(resolve));
      const row=get(name.slice(0,-5));
      if(!row)throw new Error('cultivation_state_unreadable');
      yield row;
    }
  }
  const page=(query,{collection='runs',filter=()=>true}={})=>{
    // Native writes replace files atomically, changing the directory stamp even
    // across processes. Display queries reuse an index and read only the page.
    // Authority/mutation callers still use fresh list()/get(), never this cache.
    if(!cache||directoryVersion()!==fingerprint)list();
    const project=()=>cache.filter(filter).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    let result=pageRecords(project(),workspace,collection,query);
    if(result.items.some(row=>JSON.stringify(get(row.id))!==JSON.stringify(row))){
      // Also detect in-place external changes to displayed records immediately.
      list();result=pageRecords(project(),workspace,collection,query);
    }
    return result;
  };
  return Object.freeze({
    list,scan,get,page,
    transaction:work=>withCrossProcessLock(reviewStoragePath(wsRoot,'工程/智能体培养/tasks/dispatch.lock'),work),
    create(input){if(list().length>=256)throw new Error('cultivation_storage_full');
      // createRunStore is reused with the full cultivation intent in the first atomic write.
      cache=null;return native.create(input);},
    update(key,patch){get(key);cache=null;return native.update(key,{...patch,resumeAvailable:false});},
  });
}
