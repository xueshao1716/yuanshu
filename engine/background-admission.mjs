import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {knowledgeStorage} from './knowledge-storage.mjs';

// A crashed owner never frees the slot merely because time passed. Operators
// must reconcile the actual host task before any replacement is dispatched.
const hostTermination=slot=>{
  if(slot.host!==os.hostname()||!Number.isSafeInteger(slot.pid)||slot.pid<1||slot.pid===process.pid)return null;
  try{process.kill(slot.pid,0);return null;}catch(error){return error.code==='ESRCH'?{id:slot.id,terminated:true}:null;}
};
export function createBackgroundAdmission({wsRoot,foregroundBusy=()=>false,resolveTermination=hostTermination,now=Date.now}) {
  const io=knowledgeStorage(wsRoot),owner=randomUUID();
  const read=()=>{
    const data=io.read('background-admission.json',{v:1,workspace:io.workspace,slot:null});
    const s=data.slot;
    if(data.v!==1||data.workspace!==io.workspace||s&&
      (!['knowledge','cultivation'].includes(s.consumer)||typeof s.id!=='string'||typeof s.owner!=='string'||!Number.isFinite(s.at)))
      throw new Error('background_state_unreadable');
    return data;
  };
  return Object.freeze({
    reconcile:async({expectedId,guard=()=>null,requestId,commandDigest,reason}={})=>{
      const observed=read().slot;
      if(!observed||expectedId&&observed.id!==expectedId||typeof resolveTermination!=='function')return false;
      // Evidence comes from a host adapter, never an HTTP body or elapsed time.
      const proof=await resolveTermination(Object.freeze({...observed}));
      if(proof?.id!==observed.id||proof.terminated!==true)return false;
      return io.transaction(()=>{
        const actor=guard();
        const data=read();
        if(data.slot?.id!==observed.id||data.slot?.owner!==observed.owner)return false;
        data.recoveries??=[];
        if(data.recoveries.length>=256)throw new Error('background_audit_full');
        data.recoveries.push({id:observed.id,consumer:observed.consumer,at:now(),actor,requestId,commandDigest,reason,
          evidence:'host_process_terminated',externalOutcome:'unknown',budget:'unchanged'});
        data.slot=null;io.write('background-admission.json',data);return true;
      });
    },
    status:async()=>{const s=read().slot;return s?{state:'held',id:s.id,consumer:s.consumer,at:s.at,
      recoveryRequired:!!hostTermination(s)}:{state:'idle'};},
    receipt:requestId=>read().recoveries?.find(row=>row.requestId===requestId)??null,
    // 2026-10-07 真机：培养作业要等前台空闲，小语在同一轮里等它的结果，两边互相等死。
    // 培养走独立的远端模型、不碰前台会话，调用方可声明不让前台（yieldForeground:false）；知识整理仍让前台。
    acquire:(consumer,{yieldForeground=true}={})=>io.transaction(()=>{
      if(!['knowledge','cultivation'].includes(consumer))throw new Error('background_invalid_consumer');
      if(yieldForeground&&foregroundBusy())return null;
      const data=read();if(data.slot)return null;
      if(!Number.isFinite(now()))throw new Error('background_invalid_clock');
      data.slot={id:randomUUID(),owner,consumer,at:now(),pid:process.pid,host:os.hostname()};
      io.write('background-admission.json',data);return {id:data.slot.id};
    }),
    release:id=>io.transaction(()=>{
      const data=read();if(!data.slot||data.slot.id!==id||data.slot.owner!==owner)return false;
      data.slot=null;io.write('background-admission.json',data);return true;
    }),
  });
}
