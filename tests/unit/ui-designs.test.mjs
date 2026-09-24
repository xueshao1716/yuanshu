import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const doc = () => ({title:'测试',frame:'phone',frames:[{id:'home',name:'首页',x:0,y:0}],groups:[
  {id:'g1',x:16,y:100,axis:'x',items:[{id:'i1',kind:'button',label:'开始',icon:null,variant:'filled'}]},
  {id:'g2',x:16,y:180,axis:'x',items:[{id:'i2',kind:'text',label:'保留',icon:null,variant:'filled'}]},
]});
const modules = () => Promise.all([import('../../engine/ui-design-store.mjs'),import('../../engine/ui-design-document.mjs'),import('../../engine/ui-design-service.mjs')]);
function temporary(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-ui-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }

test('UI designs: immutable versions, explicit selection, project isolation and path guards',async t=>{
  const [{createUiDesignStore}]=await modules(); const store=createUiDesignStore(temporary(t));
  const a=store.create({title:'A',brief:'A only',references:'自己的参考'}), b=store.create({title:'B',brief:'B only'});
  const first=store.append(a.id,{doc:doc(),label:'初稿'});
  const changed=doc();changed.groups[0].items[0].label='继续';
  const next=store.append(a.id,{doc:changed,label:'局部',parentId:first.id});
  assert.equal(store.get(a.id).selectedVersion,first.id);
  store.select(a.id,next.id);store.select(a.id,first.id);
  assert.equal(store.get(a.id).versions[0].doc.groups[0].items[0].label,'开始');
  assert.throws(()=>store.select(b.id,first.id),/版本/);
  assert.throws(()=>store.get('../escape'),/标识/);
  assert.equal(store.get(b.id).versions.length,0);
  assert.equal(store.list().length,2);
});

test('UI designs: rejects unsafe documents and only changes the requested group',async()=>{
  const [, {validateDocument,mergeGroup}]=await modules();
  assert.throws(()=>validateDocument({frames:[],groups:[{}]}),/画布/);
  assert.throws(()=>validateDocument({frames:[],groups:[]}),/画布/);
  let broken=doc();broken.groups[0].items[0].src='javascript:alert(1)';
  assert.throws(()=>validateDocument(broken),/素材/);
  broken=doc();broken.groups[0].items[0].action={to:'missing'};
  assert.throws(()=>validateDocument(broken),/跳转/);
  broken=doc();broken.groups[1].id='g1';assert.throws(()=>validateDocument(broken),/重复/);
  broken=doc();broken.platform='ios';assert.throws(()=>validateDocument(broken),/平台/);
  broken=doc();broken.groups[0].items[0].tabs=[{label:'bad',icon:42}];assert.throws(()=>validateDocument(broken),/标签/);
  broken=doc();broken.frames[0].note={bad:true};assert.throws(()=>validateDocument(broken),/屏幕/);
  const base=doc(),replacement={...base.groups[0],items:[{...base.groups[0].items[0],label:'报名'}]};
  const merged=mergeGroup(base,'g1',{group:replacement,frames:[],groups:[]});
  assert.deepEqual(merged.frames,base.frames);assert.deepEqual(merged.groups[1],base.groups[1]);
  assert.equal(merged.groups[0].items[0].label,'报名');assert.equal(base.groups[0].items[0].label,'开始');
  assert.throws(()=>mergeGroup(base,'g1',{group:{...replacement,id:'g2'}}),/组件/);
});

test('UI designs: background directions keep partial success and exact model; no other work context',async t=>{
  const [,,{createUiDesignService}]=await modules();let calls=0;const seen=[];
  const model={provider:'test',id:'designer'};
  const service=createUiDesignService({root:temporary(t),getModelList:()=>[model,{provider:'test',id:'image',capabilities:['image']}],defaultModel:model,
    directChat:async(m,msg,hist,opts)=>{seen.push({m,msg,hist,opts}); if(++calls===2) return null;return {text:JSON.stringify(doc()),usedModel:{provider:'test',id:'actual'}};}});
  const p=service.store.create({title:'独立作品',brief:'只用此需求',references:'此作品参考'});
  const run=service.start(p.id,{model:'test/designer'});
  assert.equal(run.status,'running');assert.throws(()=>service.start(p.id,{model:'test/designer'}),/进行/);
  await service.wait(p.id);
  const done=service.get(p.id);assert.equal(done.run.status,'partial');assert.equal(done.versions.length,1);
  assert.equal(done.versions[0].model.id,'actual');assert.equal(seen[0].hist.length,0);
  assert.match(seen[0].msg,/只用此需求/);assert.match(seen[0].msg,/此作品参考/);
  assert.throws(()=>service.start(p.id,{model:'unknown/model'}),/模型/);
  assert.throws(()=>service.start(p.id,{model:'test/image'}),/文本模型/);
  assert.throws(()=>service.start(p.id,null),/参数/);
  service.store.setRun(p.id,{id:'old',status:'running'});
  assert.equal(service.get(p.id).run.status,'interrupted');
});

test('UI designs: repairs one malformed model document, with bounded retry and same model',async t=>{
  const [,,{createUiDesignService}]=await modules();const model={provider:'test',id:'designer'};const seen=[];
  const broken=doc();delete broken.groups[0].items[0].icon;
  const service=createUiDesignService({root:temporary(t),getModelList:()=>[model],defaultModel:model,
    directChat:async(m,msg)=>{seen.push({m,msg});return {text:JSON.stringify(seen.length===1?broken:doc())};}});
  const p=service.store.create({title:'修复格式',brief:'报名'});service.start(p.id,{});await service.wait(p.id);
  assert.equal(service.get(p.id).run.status,'completed');assert.equal(seen.length,3);
  assert.match(seen[1].msg,/icon/);assert.ok(seen.every(c=>c.m===model));
  let attempts=0;
  const invalid=createUiDesignService({root:temporary(t),getModelList:()=>[model],defaultModel:model,directChat:async()=>{attempts++;return {text:JSON.stringify(broken)};}});
  const q=invalid.store.create({title:'始终错误',brief:'报名'});invalid.start(q.id,{});await invalid.wait(q.id);
  assert.equal(attempts,2);assert.equal(invalid.get(q.id).versions.length,0);
});
