import fs from 'node:fs';
import path from 'node:path';
import {createPublicKey} from 'node:crypto';

// Deployment-only trust pin. Never enroll from HTTP, generate a signing key,
// or treat the workbench bearer token as an independent human credential.
export function loadCultivationHumanConfig({env=process.env}={}) {
  const file=env.YUANSHU_CULTIVATION_HUMAN_PUBLIC_KEY_FILE;
  const actorId=env.YUANSHU_CULTIVATION_HUMAN_ACTOR;
  if(!file&&!actorId)return undefined;
  try {
    if(typeof file!=='string'||!path.isAbsolute(file)||!actorId||actorId.trim()!==actorId||
      actorId.length>120||/[\x00-\x1f]/.test(actorId))throw new Error();
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error();
    const pem=fs.readFileSync(file,'utf8').trim();
    if(!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem))throw new Error();
    const publicKey=createPublicKey(pem);
    if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519')throw new Error();
    return {publicKey,actorId};
  }catch{throw new Error('cultivation_identity_unavailable');}
}

export function optionalCultivationHumanConfig({env=process.env,warn=console.warn}={}) {
  try{return loadCultivationHumanConfig({env});}
  catch{warn('cultivation_identity_unavailable');return undefined;}
}
