import {createHash,createPublicKey,verify} from 'node:crypto';
import {exact} from './control-state.mjs';
const rp='yuanshu.localhost',origin='https://yuanshu.localhost';
const hash=value=>createHash('sha256').update(value).digest();
const fail=()=>{throw new Error('cultivation_identity_unavailable');};
function bytes(value,max){
  if(typeof value!=='string'||!value.length||value.length>max*2||!/^[A-Za-z0-9_-]+$/.test(value))fail();
  const result=Buffer.from(value,'base64url');
  if(result.length>max||result.toString('base64url')!==value)fail();
  return result;
}
// Limited COSE parser: only a definite map with the five ES256/P-256 fields.
// No generic CBOR, indefinite lengths or nesting.
function coseKey(data){
  let i=0;
  const take=()=>{if(i>=data.length)fail();return data[i++];};
  const integer=()=>{const v=take();if(v<24)return v;if(v>=32&&v<56)return -1-(v-32);fail();};
  if(take()!==0xa5)fail();
  const values=new Map();
  for(let n=0;n<5;n++){
    const key=integer();if(values.has(key)||![1,3,-1,-2,-3].includes(key))fail();
    if(key===-2||key===-3){if(take()!==0x58||take()!==32||i+32>data.length)fail();values.set(key,data.subarray(i,i+32));i+=32;}
    else values.set(key,integer());
  }
  if(i!==data.length||values.get(1)!==2||values.get(3)!==-7||values.get(-1)!==1)fail();
  return createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:values.get(-2).toString('base64url'),y:values.get(-3).toString('base64url')}});
}
export function readOwnerCredential(row,workspace){
  if(!exact(row,['version','workspace','authenticatorData'])||row.version!==1||row.workspace!==workspace||!/^[a-f0-9]{64}$/.test(workspace))fail();
  const auth=bytes(row.authenticatorData,4096);
  if(auth.length<55||!auth.subarray(0,32).equals(hash(rp))||(auth[32]&0xc5)!==0x45)fail();
  const length=auth.readUInt16BE(53);
  if(length<1||length>1024||55+length>=auth.length)fail();
  const credentialId=auth.subarray(55,55+length).toString('base64url');
  const publicKey=coseKey(auth.subarray(55+length));
  return Object.freeze({mode:'windows-hello',credentialId,publicKey,fingerprint:hash(auth).toString('hex')});
}
export function verifyOwnerAssertion(config,message,encoded){
  try{
    const proof=JSON.parse(bytes(encoded,6000).toString('utf8'));
    if(!exact(proof,['credentialId','authenticatorData','clientData','signature'])||proof.credentialId!==config.credentialId)return false;
    const client=bytes(proof.clientData,4096),auth=bytes(proof.authenticatorData,1024),signature=bytes(proof.signature,80);
    const data=JSON.parse(client.toString('utf8'));
    if(data.type!=='webauthn.get'||data.origin!==origin||(data.crossOrigin!==undefined&&data.crossOrigin!==false)||data.topOrigin!==undefined||
      data.challenge!==Buffer.from(message).toString('base64url')||auth.length!==37||
      !auth.subarray(0,32).equals(hash(rp))||(auth[32]&0xc5)!==5)return false;
    return verify('sha256',Buffer.concat([auth,hash(client)]),config.publicKey,signature);
  }catch{return false;}
}
