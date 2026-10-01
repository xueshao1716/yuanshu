import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPrivateKey,sign,KeyObject} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {commandFor} from '../engine/cultivation/api.mjs';
import {commandHash} from '../engine/cultivation/identity.mjs';
import {exact,id} from '../engine/cultivation/control-state.mjs';
const fail=code=>{throw new Error(`signer_${code}`);};
export function reviewChallenge(pkg,{workspace,now=Date.now()}){
  if(!/^[a-f0-9]{64}$/.test(workspace)||!exact(pkg,['id','message','expiresAt','command'])||
    !id(pkg.id)||typeof pkg.message!=='string'||pkg.message.length>4096||
    !exact(pkg.command,['method','path','body']))fail('invalid_challenge');
  const row=JSON.parse(pkg.message),command=commandFor(pkg.command.method,pkg.command.path,pkg.command.body);
  if(!exact(row,['domain','id','workspace','commandHash','at','expiresAt','epoch'])||
    row.domain!=='yuanshu-cultivation-human-v1'||row.workspace!==workspace||row.id!==pkg.id||
    row.commandHash!==commandHash(command)||row.expiresAt!==pkg.expiresAt||
    !Number.isSafeInteger(row.epoch)||row.epoch<0||![row.at,row.expiresAt,now].every(Number.isFinite)||
    row.at>now||row.expiresAt<=now||row.expiresAt-row.at>60000||row.expiresAt<=row.at)fail('invalid_challenge');
  return {command,workspace,expiresAt:row.expiresAt,id:row.id};
}
export function signChallenge(pkg,{workspace,privateKey,confirmation,now=Date.now()}){
  reviewChallenge(pkg,{workspace,now});
  if(confirmation!==`APPROVE ${pkg.id}`)fail('confirmation_required');
  const key=privateKey instanceof KeyObject?privateKey:createPrivateKey(privateKey);
  if(key.type!=='private'||key.asymmetricKeyType!=='ed25519')fail('invalid_key');
  return sign(null,Buffer.from(pkg.message),key).toString('base64url');
}
function readLocal(file,max){
  if(!path.isAbsolute(file))fail('absolute_path_required');
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>max)fail('invalid_file');
  return fs.readFileSync(file,'utf8');
}
async function main(){
  const [workspace,keyFile,requestFile]=process.argv.slice(2);
  if(!workspace||!keyFile||!requestFile)throw new Error('Usage: node scripts/cultivation-sign.mjs WORKSPACE_SHA256 ABS_PRIVATE_KEY ABS_REQUEST_JSON');
  if(!process.stdin.isTTY||!process.stdout.isTTY)fail('interactive_terminal_required');
  const pkg=JSON.parse(readLocal(requestFile,100000));
  console.log('核对工作区与完整操作；本工具不会发送请求。私钥不进入网页。');
  console.log(JSON.stringify(reviewChallenge(pkg,{workspace}),null,2));
  const rl=createInterface({input:process.stdin,output:process.stdout});
  try{
    const confirmation=await rl.question(`同意请原样输入 APPROVE ${pkg.id}：`);
    const signature=signChallenge(pkg,{workspace,privateKey:readLocal(keyFile,8192),confirmation});
    console.log('一次性签名（复制到培养面板）：\n'+signature);
  }finally{rl.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
