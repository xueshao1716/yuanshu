import {exact,id} from './control-state.mjs';
import {clonePayload} from './state.mjs';
import {commandHash} from './identity.mjs';
const fail=code=>{throw new Error(`cultivation_${code}`);};
export function validateRecoveryCommand(c){
  if(!exact(c,['action','requestId','expectedRevision','payload'])||c.action!=='resources.reconcile'||
    !id(c.requestId)||!Number.isSafeInteger(c.expectedRevision)||c.expectedRevision<0||
    !exact(c.payload,['slotId','reason'])||!id(c.payload.slotId)||typeof c.payload.reason!=='string'||
    !c.payload.reason.trim()||c.payload.reason.length>1000)fail('invalid_command');
}
export function createRecoveryCommands({authority,controls,admission}){
  return async(input,principal)=>{
    const c=clonePayload(input);validateRecoveryCommand(c);
    const actor=authority.assert(principal,c,['human']),digest=commandHash(c);
    if(!admission)fail('executor_unavailable');
    const existing=()=>{
      const receipt=admission.receipt(c.requestId);
      if(receipt&&(receipt.commandDigest!==digest||receipt.actor?.actorId!==actor.actorId))fail('idempotency_conflict');
      return receipt?{recovered:true,receipt}:null;
    };
    const previous=existing();if(previous)return previous;
    const guard=()=>{const live=authority.assert(principal,c,['human']);
      if(controls.read().revision!==c.expectedRevision)fail('revision_conflict');return live;};
    guard();
    const recovered=await admission.reconcile({expectedId:c.payload.slotId,reason:c.payload.reason,
      requestId:c.requestId,commandDigest:digest,guard});
    authority.assert(principal,c,['human']);
    const receipt=existing();if(receipt)return receipt;
    if(!recovered)fail('recovery_unavailable');
    fail('state_unreadable');
  };
}
