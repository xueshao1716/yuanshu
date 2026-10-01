import {createHash} from 'node:crypto';
import {withCrossProcessLock} from '../file-lock.mjs';
import {reviewStoragePath,reviewAtomicWrite} from '../review-file-safety.mjs';
import {readReviewBounded} from '../review-read.mjs';
import {exact,id} from './control-state.mjs';
import {clonePayload} from './state.mjs';

const kinds=['appearance','clothing','voice'],hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw new Error('cultivation_asset_unverified');};
const assetId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateMediaCommand(c){
  const fields=c.action==='asset.bind'?['agentId','kind','path']:['agentId','id','version'];
  if(!exact(c,['action','requestId','expectedRevision','payload'])||!id(c.requestId)||
    !Number.isSafeInteger(c.expectedRevision)||c.expectedRevision<0||
    !['asset.bind','asset.revoke'].includes(c.action)||!exact(c.payload,fields)||!id(c.payload.agentId))
    throw new Error('cultivation_invalid_command');
  if(c.action==='asset.bind'&&(!kinds.includes(c.payload.kind)||typeof c.payload.path!=='string'))fail();
  if(c.action==='asset.revoke'&&(!assetId(c.payload.id)||c.payload.version!==1))fail();
}
function mime(bytes,kind){
  const head=bytes.subarray(0,16),text=head.toString('ascii');
  if(kind!=='voice'){
    if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
    if(head[0]===255&&head[1]===216&&head[2]===255)return 'image/jpeg';
    if(text.startsWith('RIFF')&&text.slice(8,12)==='WEBP')return 'image/webp';
  }else{
    if(text.startsWith('RIFF')&&text.slice(8,12)==='WAVE')return 'audio/wav';
    if(text.startsWith('OggS'))return 'audio/ogg';
    if(text.startsWith('ID3')||head[0]===255&&(head[1]&224)===224)return 'audio/mpeg';
  }
  fail();
}
// Immutable copied bytes, never a caller-supplied preview URL or live source path.
export function createCultivationMedia({wsRoot,store,authority,getControls,now=Date.now}){
  const location=relative=>reviewStoragePath(wsRoot,`工程/智能体培养/media/${relative}`);
  const read=()=>{
    let data;try{data=JSON.parse(readReviewBounded(location('registry.json'),512*1024));}
    catch(error){if(error.code==='ENOENT')return {workspace:store.workspace,records:[],receipts:[]};throw error;}
    if(data.workspace!==store.workspace||!Array.isArray(data.records)||data.records.length>256||
      !Array.isArray(data.receipts)||data.receipts.length>512)fail();
    return data;
  };
  const get=input=>{
    try{
      if(!exact(input,['agentId','kind','id','version'])||!id(input.agentId)||!kinds.includes(input.kind)||!assetId(input.id)||input.version!==1)fail();
      const row=read().records.find(r=>r.id===input.id&&r.agentId===input.agentId&&r.kind===input.kind&&r.version===1);
      if(!row||row.revoked)fail();
      const bytes=readReviewBounded(location(`${row.agentId}/${row.id}.bin`),2*1024*1024);
      if(hash(bytes)!==row.hash||hash(JSON.stringify([row.agentId,row.kind,row.hash]))!==row.id||mime(bytes,row.kind)!==row.mime)fail();
      return {mime:row.mime,base64:bytes.toString('base64')};
    }catch{fail();}
  };
  const execute=async(input,principal)=>{
    const c=clonePayload(input);validateMediaCommand(c);
    const authenticate=()=>{
      const actor=authority.assert(principal,c,c.action==='asset.revoke'?['human']:['mother']);
      const state=getControls().read(),agent=state.data.agents.find(a=>a.id===c.payload.agentId);
      if(!agent||actor.kind==='mother'&&agent.mentorId!==actor.actorId)throw new Error('cultivation_identity_denied');
      if(state.revision!==c.expectedRevision)throw new Error('cultivation_revision_conflict');
      return actor;
    };
    authenticate();
    return withCrossProcessLock(location('registry.lock'),()=>{
      const actor=authenticate(),data=read(),commandHash=hash(JSON.stringify(c));
      const prior=data.receipts.find(r=>r.requestId===c.requestId);
      if(prior){if(prior.commandHash!==commandHash||JSON.stringify(prior.actor)!==JSON.stringify(actor))
        throw new Error('cultivation_idempotency_conflict');return structuredClone(prior.result);}
      if(data.receipts.length>=512)throw new Error('cultivation_storage_full');
      const p=c.payload;let result;
      if(c.action==='asset.bind'){
        if(data.records.length>=256)throw new Error('cultivation_storage_full');
        let bytes,type;try{
          if(!p.path.startsWith('workshop-out/')||p.path.length>400)fail();
          bytes=readReviewBounded(reviewStoragePath(wsRoot,p.path),2*1024*1024);type=mime(bytes,p.kind);
        }catch{fail();}
        const contentHash=hash(bytes),key=hash(JSON.stringify([p.agentId,p.kind,contentHash]));
        const existing=data.records.find(r=>r.id===key);if(existing?.revoked)fail();
        if(!existing){
          reviewAtomicWrite(location(`${p.agentId}/${key}.bin`),bytes);
          data.records.push({id:key,version:1,agentId:p.agentId,kind:p.kind,hash:contentHash,mime:type,revoked:false,actor,at:now()});
        }
        result={asset:{id:key,version:1}};
      }else{
        const row=data.records.find(r=>r.agentId===p.agentId&&r.id===p.id&&r.version===p.version);if(!row)fail();
        row.revoked=true;row.revokedBy=actor;row.revokedAt=now();result={revoked:true};
      }
      data.receipts.push({requestId:c.requestId,commandHash,actor,result});
      const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>512*1024)throw new Error('cultivation_storage_full');
      reviewAtomicWrite(location('registry.json'),serialized);return structuredClone(result);
    });
  };
  return Object.freeze({get,execute,verify(input){try{get(input);return true;}catch{return false;}}});
}
