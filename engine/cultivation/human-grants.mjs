import {createPublicKey, KeyObject, randomUUID, verify} from 'node:crypto';
import {commandHash} from './identity.mjs';

const fail = code => {throw new Error(`cultivation_identity_${code}`);};
// The deployment host pins a public key. Neither HTTP bodies nor model tools
// can enroll keys. Keys used by unit tests are synthetic, never user identity.
export function createHumanGrants({workspace,publicKey,actorId,now=Date.now,ttlMs=30000,proofVerifier}) {
  if(!/^[a-f0-9]{64}$/.test(workspace)||typeof actorId!=='string'||!actorId.trim()||actorId!==actorId.trim()||
    actorId.length>120||/[\x00-\x1f]/.test(actorId)||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)
    fail('unavailable');
  let key=null,epoch=0;
  if(publicKey){
    // createPublicKey also accepts private PEMs; do not silently retain that
    // deployment mistake. Accept only a public KeyObject or SPKI public PEM.
    if(publicKey instanceof KeyObject){
      if(publicKey.type!=='public')fail('unavailable');
      key=publicKey;
    }else{
      if(typeof publicKey!=='string'&&!Buffer.isBuffer(publicKey))fail('unavailable');
      const pem=publicKey.toString().trim();
      if(!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem))fail('unavailable');
      try {key=createPublicKey(pem);}catch{fail('unavailable');}
    }
    if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')fail('unavailable');
  }
  const challenges=new Map(),sources=new WeakMap();
  if(proofVerifier!==undefined&&typeof proofVerifier!=='function')fail('unavailable');
  const available=!!key||typeof proofVerifier==='function';
  const fresh=row=>Number.isFinite(now())&&now()>=row.at&&now()<row.expiresAt&&row.epoch===epoch;
  const challenge=command=>{
    if(!available)fail('unavailable');
    for(const [id,row] of challenges)if(!fresh(row))challenges.delete(id);
    if(challenges.size>=128||!Number.isFinite(now()))fail('denied');
    const row={id:randomUUID(),workspace,commandHash:commandHash(command),at:now(),expiresAt:now()+ttlMs,epoch};
    // Fixed serialization/domain separation; the user signs these exact bytes.
    const message=JSON.stringify({domain:'yuanshu-cultivation-human-v1',...row});
    challenges.set(row.id,{...row,message});
    return Object.freeze({id:row.id,message,expiresAt:row.expiresAt});
  };
  return Object.freeze({available,challenge,
    verify:(proof,command)=>{
      if(!available)fail('unavailable');
      if(!proof||Object.keys(proof).length!==2||typeof proof.id!=='string'||
        typeof proof.signature!=='string'||(proofVerifier?!/^[A-Za-z0-9_-]{1,8192}$/.test(proof.signature):!/^[A-Za-z0-9_-]{86}$/.test(proof.signature)))fail('denied');
      const row=challenges.get(proof.id);
      if(!row||!fresh(row)||row.commandHash!==commandHash(command)||
        !(proofVerifier?proofVerifier(row.message,proof.signature)===true:verify(null,Buffer.from(row.message),key,Buffer.from(proof.signature,'base64url'))))fail('denied');
      challenges.delete(row.id);
      const source=Object.freeze({});sources.set(source,row);return source;
    },
    resolveHuman:(source,context)=>{
      const row=sources.get(source);
      return row&&fresh(row)&&context?.workspace===workspace&&context?.kind==='human'&&
        context.commandHash===row.commandHash?{actorId,originId:`grant:${row.id}`}:null;
    },
    revoke:()=>{epoch++;challenges.clear();},
  });
}
