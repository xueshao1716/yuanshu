import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {designError} from './ui-design-document.mjs';
import {exportWebsite} from './website-document.mjs';

export async function handleWebsite(service,json,res,action,id,input={},dependencies={}) {
  try {
    if(!input||typeof input!=='object'||Array.isArray(input)) throw designError('作品参数格式错误');
    if(action==='templates') return json(res,200,{templates:service.templates});
    if(action==='list') return json(res,200,{projects:service.store.list()});
    if(action==='create') return json(res,201,service.create(input));
    if(action==='get') return json(res,200,service.get(id));
    if(action==='versions') return json(res,201,service.store.append(id,{doc:input.doc,label:input.label,parentId:input.parentId}));
    if(action==='select') return json(res,200,service.store.select(id,input.versionId));
    if(action==='generate') return json(res,202,service.start(id,input));
    if(action==='cancel') return json(res,200,service.cancel(id));
    if(action==='export'||action==='share') {
      const p=service.get(id),version=p.versions.find(v=>v.id===input.versionId);
      if(!version) throw designError('版本不属于这个作品');
      const html=exportWebsite(version.doc,p.title),filename=`website-${p.id.slice(0,8)}-${version.id.slice(0,8)}.html`;
      if(action==='export') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'});return res.end(html);
      }
      // Generated files only; never accept a path to arbitrary workspace content.
      const root=path.resolve(dependencies.root),out=path.join(root,'workshop-out','website-exports');
      for(const dir of [path.join(root,'workshop-out'),out]) {
        if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink()) throw designError('导出目录不能是链接');
        fs.mkdirSync(dir,{recursive:true});
      }
      const target=path.join(out,`${randomUUID()}-${filename}`);
      fs.writeFileSync(target,html,{flag:'wx'});
      try {
        const share=dependencies.share||(await import('./tools/unified-tools.mjs')).executeShareProject;
        const result=await share({path:target},{cwd:root});
        if(result.isError) throw designError(result.text,503);
        return json(res,200,{url:result.details.url,message:'已发布此版本；后续修改需重新分享'});
      } finally {fs.unlinkSync(target);}
    }
    throw designError('未知工坊操作',404);
  } catch(error) {return json(res,error.statusCode||500,{error:error.statusCode?error.message:'作品读写失败，请稍后重试'});}
}

export function websiteRoutes(service,{json,readBody,root}) {
  const call=(res,action,id,input)=>handleWebsite(service,json,res,action,id,input,{root});
  return [
    ['GET','/api/workshop-sites/templates',res=>call(res,'templates')],
    ['GET','/api/workshop-sites/projects',res=>call(res,'list')],
    ['POST','/api/workshop-sites/projects',async(res,req)=>call(res,'create',null,await readBody(req,1))],
    ['GET',/^\/api\/workshop-sites\/projects\/([^/]+)$/, (res,req,url,m)=>call(res,'get',m[1])],
    ['GET',/^\/api\/workshop-sites\/projects\/([^/]+)\/export\/([^/]+)$/, (res,req,url,m)=>call(res,'export',m[1],{versionId:m[2]})],
    ['POST',/^\/api\/workshop-sites\/projects\/([^/]+)\/(versions|select|generate|cancel|share)$/,async(res,req,url,m)=>call(res,m[2],m[1],await readBody(req,2))],
  ];
}
