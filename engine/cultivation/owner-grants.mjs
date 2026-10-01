import {createHumanGrants} from './human-grants.mjs';
import {verifyOwnerAssertion} from './owner-webauthn.mjs';

export function createOwnerGrants({workspace,provider,now=Date.now}){
  let pinned=null,grants=null,locked=false;
  const current=()=>{
    if(locked)return null;
    try{
      const config=provider();
      if(pinned&&config?.fingerprint!==pinned){locked=true;grants?.revoke();return null;}
      if(!config)return null;
      if(!grants){
        pinned=config.fingerprint;
        grants=createHumanGrants({workspace,actorId:'windows-hello-owner',now,ttlMs:60000,
          proofVerifier:(message,signature)=>verifyOwnerAssertion(config,message,signature)});
      }
      return grants;
    }catch{locked=true;grants?.revoke();return null;}
  };
  const required=()=>{const result=current();if(!result)throw new Error('cultivation_identity_unavailable');return result;};
  return Object.freeze({
    get available(){return !!current();},
    get state(){current();return locked?'locked':pinned?'paired':'unpaired';},
    challenge:command=>required().challenge(command),
    verify:(proof,command)=>required().verify(proof,command),
    resolveHuman:(source,context)=>current()?.resolveHuman(source,context)??null,
    revoke:()=>grants?.revoke(),
  });
}
