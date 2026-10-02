import fs from 'node:fs';
import {withFileLock} from '../file-lock.mjs';
import {reviewStoragePath,reviewAtomicWrite} from '../review-file-safety.mjs';
import {readReviewBounded} from '../review-read.mjs';
import {id} from './control-state.mjs';

const actions=new Set(['policy.set','design.submit','design.revise','agent.register','agent.adopt','agent.resume','agent.rollback',
  'agent.pause','agent.archive','run.submit','run.cancel','learning.decide','asset.revoke','resources.reconcile']);
const fields=['requestId','action','commandHash','actorKind','expectedRevision','error','outcome','count','at','lastAt'];
const valid=r=>r&&Object.keys(r).length===fields.length&&Object.keys(r).every(k=>fields.includes(k))&&id(r.requestId)&&
  actions.has(r.action)&&typeof r.commandHash==='string'&&/^[a-f0-9]{64}$/.test(r.commandHash)&&
  ['mother','human'].includes(r.actorKind)&&Number.isSafeInteger(r.expectedRevision)&&r.expectedRevision>=0&&
  typeof r.error==='string'&&/^cultivation_[a-z_]+$/.test(r.error)&&r.outcome==='denied'&&Number.isSafeInteger(r.count)&&r.count>0&&
  [r.at,r.lastAt].every(v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v)&&Number.isFinite(Date.parse(v)));

// Separate bounded diagnostic history: no policy revision, raw payload, token or model call.
export function createDenialHistory({wsRoot,workspace,now=Date.now}) {
  const root=fs.realpathSync(wsRoot),location=()=>reviewStoragePath(root,'工程/智能体培养/denials.json');
  const read=()=>{
    try {const value=JSON.parse(readReviewBounded(location(),256*1024).toString('utf8'));
      if(value.v!==1||value.workspace!==workspace||!Array.isArray(value.items)||value.items.length>200||
        value.items.some(r=>!valid(r)))
        throw new Error('invalid denial history');
      return value;
    }catch(error){if(error.code==='ENOENT')return {v:1,workspace,items:[]};throw new Error('cultivation_audit_unavailable');}
  };
  return Object.freeze({
    list:()=>{const data=read();return {items:structuredClone(data.items.slice(-20).reverse()),retained:data.items.length,limit:200};},
    async record(command,actor,error){
      const at=new Date(now()).toISOString(),entry={requestId:command?.requestId,action:command?.action,
        commandHash:actor?.commandHash,actorKind:actor?.kind,expectedRevision:command?.expectedRevision,
        error,outcome:'denied',count:1,at,lastAt:at};
      if(!valid(entry))
        return {recorded:false,reason:'invalid_request_metadata'};
      return withFileLock(location(),()=>{
        const data=read();
        const row=data.items.find(r=>r.requestId===command.requestId&&r.commandHash===actor.commandHash&&r.error===error);
        if(row){row.count=Math.min(Number.MAX_SAFE_INTEGER,row.count+1);row.lastAt=at;}else data.items.push(entry);
        data.items=data.items.slice(-200);
        const text=JSON.stringify(data);if(Buffer.byteLength(text)>256*1024)throw new Error('cultivation_audit_unavailable');
        reviewAtomicWrite(location(),text);return {recorded:true};
      });
    },
  });
}
