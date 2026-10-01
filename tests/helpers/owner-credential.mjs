// Synthetic P256 credentials only; never a real owner or Windows registration.
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
const hash=v=>createHash('sha256').update(v).digest();
export function credential(){
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=keys.publicKey.export({format:'jwk'});
  const id=Buffer.from('fixture-credential');
  const cose=Buffer.concat([Buffer.from([0xa5,1,2,3,0x26,0x20,1,0x21,0x58,32]),Buffer.from(jwk.x,'base64url'),Buffer.from([0x22,0x58,32]),Buffer.from(jwk.y,'base64url')]);
  const auth=Buffer.concat([hash('yuanshu.localhost'),Buffer.from([0x45,0,0,0,0]),Buffer.alloc(16),Buffer.from([0,id.length]),id,cose]);
  return {...keys,id,auth};
}
export function proof(c,message,mutate=x=>x){
  const data=mutate({type:'webauthn.get',origin:'https://yuanshu.localhost',challenge:Buffer.from(message).toString('base64url'),crossOrigin:false});
  const client=Buffer.from(JSON.stringify(data)),auth=Buffer.concat([hash('yuanshu.localhost'),Buffer.from([5,0,0,0,1])]);
  const signature=sign('sha256',Buffer.concat([auth,hash(client)]),c.privateKey);
  return Buffer.from(JSON.stringify({credentialId:c.id.toString('base64url'),authenticatorData:auth.toString('base64url'),clientData:client.toString('base64url'),signature:signature.toString('base64url')})).toString('base64url');
}
