import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {initWorkspaceApi,handleWsDeliver,handleWsPackage} from '../../engine/workspace-api.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-export-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'记忆/知识'),{recursive:true});
 fs.writeFileSync(path.join(root,'记忆/知识/private.json'),'private knowledge');
 fs.writeFileSync(path.join(root,'记忆/public.txt'),'public');
 initWorkspaceApi({wsRoot:root});return root;
}
const response=()=>({status:0,writeHead(n){this.status=n;},end(body){this.body=JSON.parse(body);}});
test('direct knowledge export and a junction alias are denied',async t=>{
 const root=fixture(t);fs.symlinkSync(path.join(root,'记忆/知识'),path.join(root,'alias'),'junction');
 for(const source of ['记忆/知识','记忆/知识/private.json','alias']){
  for(const handler of [handleWsDeliver,handleWsPackage]){
   const res=response();await handler(res,{sourcePath:source,path:source});
   assert.equal(res.status,403,`${handler.name}: ${source}`);
   assert.ok(!JSON.stringify(res.body).includes(root));
  }
 }
});
test('ancestor delivery filters private knowledge and preserves ordinary files',async t=>{
 const root=fixture(t),res=response();await handleWsDeliver(res,{sourcePath:'记忆',name:'memory'});
 assert.equal(res.status,200);const target=path.join(root,res.body.path);
 assert.equal(fs.readFileSync(path.join(target,'public.txt'),'utf8'),'public');
 assert.equal(fs.existsSync(path.join(target,'知识')),false);
 assert.equal(fs.readFileSync(path.join(root,'记忆/知识/private.json'),'utf8'),'private knowledge');
});
test('a nested junction is rejected instead of copying its target',async t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'docs'));
 fs.symlinkSync(path.join(root,'记忆/知识'),path.join(root,'docs/link'),'junction');
 const res=response();await handleWsDeliver(res,{sourcePath:'docs',name:'linked'});
 assert.equal(res.status,403);assert.equal(fs.existsSync(path.join(root,'交付/linked-v1')),false);
});
test('workspace-root delivery does not recursively export delivery output',async t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'交付'));fs.writeFileSync(path.join(root,'交付/old.txt'),'old');
 const res=response();await handleWsDeliver(res,{sourcePath:'.',name:'snapshot'});
 assert.equal(res.status,200);const target=path.join(root,res.body.path);
 assert.equal(fs.existsSync(path.join(target,'交付')),false);
 assert.equal(fs.existsSync(path.join(target,'记忆/知识')),false);
 assert.equal(fs.existsSync(path.join(target,'记忆/public.txt')),true);
});
test('real archive contains only exportable files, not knowledge snapshots',async t=>{
 const root=fixture(t),res=response();await handleWsPackage(res,{path:'记忆'});
 assert.equal(res.status,200,JSON.stringify(res.body));
 const zip=path.join(root,res.body.path).replaceAll("'","''");
 const list=execFileSync('powershell',['-NoProfile','-Command',`Add-Type -AssemblyName System.IO.Compression.FileSystem; $archive=[IO.Compression.ZipFile]::OpenRead('${zip}'); try { $archive.Entries.FullName } finally { $archive.Dispose() }`],{encoding:'utf8',windowsHide:true});
 assert.ok(list.includes('public.txt'));assert.ok(!list.includes('private.json'));
});
test('repository ignores private knowledge in both root and nested workspaces',()=>{
 const repo=new URL('../../',import.meta.url);
 const paths=['记忆/知识/state.json','example/记忆/知识/entries/a.json'];
 const result=execFileSync('git',['check-ignore','--stdin'],{cwd:repo,input:paths.join('\n'),encoding:'utf8'});
 assert.equal(result.trim().split('\n').length,2);
});
