import fs from 'node:fs';
import path from 'node:path';
import {readOwnerCredential} from './owner-webauthn.mjs';

// Read-only host deployment boundary. HTTP and model APIs cannot enroll keys.
export function ownerConfigProvider({workspace,env=process.env,platform=process.platform}){
  const root=env.LOCALAPPDATA;
  if(platform!=='win32'||!root||!path.isAbsolute(root)||!/^[a-f0-9]{64}$/.test(workspace))return ()=>null;
  const dir=path.join(root,'Yuanshu','owner-confirmation'),file=path.join(dir,workspace+'.json');
  return ()=>{
    try{
      for(const entry of [root,path.join(root,'Yuanshu'),dir,file]){
        const stat=fs.lstatSync(entry);if(stat.isSymbolicLink())throw new Error('unsafe_owner_path');
        if(entry===file&&(!stat.isFile()||stat.nlink!==1||stat.size>10000))throw new Error('unsafe_owner_file');
      }
      return readOwnerCredential(JSON.parse(fs.readFileSync(file,'utf8')),workspace);
    }catch(error){if(error.code==='ENOENT')return null;throw new Error('cultivation_identity_unavailable');}
  };
}
