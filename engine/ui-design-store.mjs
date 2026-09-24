import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { designError, validateDocument } from './ui-design-document.mjs';

const identifier = value => {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw designError('作品标识无效');
  return value;
};
const text = (value,max) => String(value || '').trim().slice(0,max);

export function createUiDesignStore(root, {directory='ui-designs', validate=validateDocument} = {}) {
  if (!['ui-designs','website-projects'].includes(directory)) throw designError('作品目录无效');
  const base = path.resolve(root), dir = path.join(base,'workshop-out',directory);
  function ensure() {
    fs.mkdirSync(base,{recursive:true});
    let parent=base;
    for (const part of ['workshop-out',directory]) {
      parent=path.join(parent,part);
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) throw designError('作品目录不能是链接');
      fs.mkdirSync(parent,{recursive:true});
    }
  }
  function file(id) {
    identifier(id);ensure();const target=path.join(dir,`${id}.json`);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw designError('作品文件不能是链接');
    return target;
  }
  function get(id) {
    const target=file(id);
    if (!fs.existsSync(target)) throw designError('作品不存在',404);
    return JSON.parse(fs.readFileSync(target,'utf8'));
  }
  function save(p) {
    p.updatedAt=new Date().toISOString();
    const target=file(p.id), tmp=path.join(dir,`${p.id}.${randomUUID()}.tmp`);
    try { fs.writeFileSync(tmp,JSON.stringify(p,null,2),{flag:'wx'}); fs.renameSync(tmp,target); }
    finally { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return p;
  }
  return {
    get,
    create(input) {
      const title=text(input?.title,100), brief=text(input?.brief,6000);
      if (!title || !brief) throw designError('请填写作品名称和需求');
      return save({id:randomUUID(),title,brief,references:text(input.references,6000),createdAt:new Date().toISOString(),versions:[],selectedVersion:null,run:null});
    },
    list() {
      ensure();return fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>{
        const p=get(f.slice(0,-5));return {id:p.id,title:p.title,brief:p.brief,updatedAt:p.updatedAt,versionCount:p.versions.length};
      }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    },
    append(id,{doc,label,parentId=null,model=null}) {
      const valid=validate(doc),p=get(id);
      if(parentId && !p.versions.some(v=>v.id===parentId)) throw designError('父版本不属于这个作品');
      if(p.versions.length>=100) throw designError('此作品已有 100 个版本，请另建作品');
      const v={id:randomUUID(),label:text(label,100)||'画布保存',parentId,createdAt:new Date().toISOString(),doc:valid,
        model:model?{provider:text(model.provider,100),id:text(model.id,200)}:null,validation:'structure-passed'};
      p.versions.push(v);p.selectedVersion ||= v.id;save(p);return v;
    },
    select(id,versionId) {
      const p=get(id);if(!p.versions.some(v=>v.id===versionId)) throw designError('版本不属于这个作品');
      p.selectedVersion=versionId;return save(p);
    },
    setRun(id,run) {const p=get(id);p.run=run;return save(p);},
  };
}
