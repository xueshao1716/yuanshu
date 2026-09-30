import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

const denied=()=>Object.assign(new Error('export_denied'),{code:'export_denied'});
const inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
const privateKnowledge=file=>/(^|\/)记忆\/知识(\/|$)/u.test(file.replaceAll('\\','/'));

// Validate every path component, including junctions inside an otherwise allowed root.
export function assertExportPath(root,file){
 root=path.resolve(root);file=path.resolve(file);
 if(!inside(root,file)||privateKnowledge(path.relative(root,file)))throw denied();
 const parts=path.relative(root,file).split(path.sep).filter(Boolean);let current=root;
 for(const part of ['',...parts]){
  if(part)current=path.join(current,part);
  const stat=fs.lstatSync(current);
  if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw denied();
 }
 return file;
}
export function exportDeliveryRoot(root){
 assertExportPath(root,root);
 const destination=path.join(root,'交付');
 if(fs.existsSync(destination))assertExportPath(root,destination);
 else fs.mkdirSync(destination);
 return destination;
}

// Snapshot a bounded export plan before creating output. No nested delivery recursion.
export async function stageWorkspaceExport(root,source){
 assertExportPath(root,source);
 const entries=[];let bytes=0,visited=0;
 const sourceIsDirectory=fs.statSync(source).isDirectory();
 async function visit(file,rel){
  if(++visited>20000)throw Object.assign(new Error('export_limit'),{code:'export_limit'});
  if(privateKnowledge(path.relative(root,file)))return;
  if(path.resolve(source)===path.resolve(root)&&path.relative(root,file).split(path.sep)[0]==='交付')return;
  assertExportPath(root,file);
  const stat=await fs.promises.lstat(file);
  if(stat.isDirectory()){
   entries.push({file,rel,directory:true});
   for(const name of await fs.promises.readdir(file))await visit(path.join(file,name),path.join(rel,name));
  }else if(stat.isFile()){
   bytes+=stat.size;if(bytes>512*1024*1024)throw Object.assign(new Error('export_limit'),{code:'export_limit'});
   entries.push({file,rel,stat});
  }else throw denied();
 }
 await visit(source,sourceIsDirectory?'':path.basename(source));
 const stage=await fs.promises.mkdtemp(path.join(os.tmpdir(),'yuanshu-export-stage-'));
 const cleanup=()=>fs.promises.rm(stage,{recursive:true,force:true});
 try{
  const content=path.join(stage,'content');await fs.promises.mkdir(content);
  for(const entry of entries){
   const target=path.join(content,entry.rel);
   if(entry.directory){await fs.promises.mkdir(target,{recursive:true});continue;}
   assertExportPath(root,entry.file);
   const handle=await fs.promises.open(entry.file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   try{
    const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink>1||stat.ino!==entry.stat.ino||stat.size!==entry.stat.size||stat.mtimeMs!==entry.stat.mtimeMs)throw denied();
    await pipeline(handle.createReadStream({autoClose:false}),fs.createWriteStream(target,{flags:'wx'}));
   }finally{await handle.close();}
  }
  return {stage,content,isDirectory:sourceIsDirectory,file:path.join(content,path.basename(source)),cleanup};
 }catch(e){await cleanup();throw e;}
}
export function exportError(error){
 return error?.code==='export_denied'
  ?{status:403,message:'私人知识、链接目录或越界路径不能导出。'}
  :error?.code==='export_limit'?{status:413,message:'导出范围过大，请选择较小的目录（最多 20000 项、512 MiB）。'}
  :{status:500,message:'导出失败。请核对源文件是否可读后重试。'};
}
