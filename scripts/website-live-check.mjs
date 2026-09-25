// Opt-in paid model acceptance. All artifacts/state go to a new temporary workspace.
// node scripts/website-live-check.mjs provider/model [checkpoint-workspace-to-copy]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseHTML} from 'linkedom';

const modelKey=process.argv[2];
if(!modelKey?.includes('/'))throw new Error('Specify provider/model explicitly');
const split=modelKey.indexOf('/'),provider=modelKey.slice(0,split),id=modelKey.slice(split+1);
const readJsonFile=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const agent=path.join(os.homedir(),'.pi','agent');
const authPath=path.join(agent,'auth.json'),modelsPath=path.join(agent,'models-store.json');
const auth=readJsonFile(authPath),store=readJsonFile(modelsPath);
const definition=store[provider]?.models?.find(m=>m.id===id);
if(!definition||!auth[provider]?.key)throw new Error('Configured model and key required');
const model={...definition,provider};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-website-live-'));
Object.assign(process.env,{YUANSHU_CWD:root,PI_WEB_CWD:root,PI_WORKSPACE:root,
  YUANSHU_AGENT_DIR:path.join(root,'agent'),PI_WEB_AGENT_DIR:path.join(root,'agent')});
const {initModelClient,directChat}=await import('../engine/model-client.mjs');
const {createWebsiteService}=await import('../engine/website-service.mjs');
const {exportWebsite,selectedHtml}=await import('../engine/website-document.mjs');
initModelClient({readJsonFile,authPath,modelsPath,resolveAuth:p=>({key:auth[p]?.key,baseUrl:auth[p]?.baseUrl||''}),getModelList:()=>[model]});
const service=createWebsiteService({root,getModelList:()=>[model],getDefaultModel:()=>model,directChat});
const seed=process.argv[3],seedFiles=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(seed){
  const source=path.join(path.resolve(seed),'workshop-out','website-projects');
  const target=path.join(root,'workshop-out','website-projects');
  fs.mkdirSync(target,{recursive:true});
  for(const name of fs.readdirSync(source).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){
    const file=path.join(source,name),bytes=fs.readFileSync(file);
    seedFiles.push({file,digest:hash(bytes)});fs.writeFileSync(path.join(target,name),bytes,{flag:'wx'});
  }
  assert.equal(seedFiles.length,1,'Use one isolated checkpoint project');
}
const project=seed?service.get(service.store.list()[0].id):service.create({title:'临海书店 · 运行验收',
  brief:'原创中文海边书店单页，恰好两个区块：开场和三本推荐书。海蓝与奶油白，鲜明字体层级，纯HTML/CSS，不用图片，手机布局不溢出。每区块简洁但有设计感。',model:modelKey});
const original=project.selectedVersion,prior=structuredClone(project.run?.checkpoint),priorCalls=project.run?.calls?.length||0;
if(seed)service.start(project.id,{resume:true});
const facts={requested:modelKey,protocol:model.api,root,seedCopied:!!seed,passed:false};
let last='';
const progress=setInterval(()=>{
  const r=service.get(project.id).run;
  const status=JSON.stringify({status:r.status,stage:r.stage,sections:r.checkpoint.sections.length});
  if(status!==last){console.log(status);last=status;}
},3000);
const calls=r=>r.calls.map(c=>({key:c.key,startedAt:c.startedAt,finishedAt:c.finishedAt,
  usedModel:c.usedModel,finishReason:c.finishReason,characters:c.characters,failed:c.failed,outputBudget:c.outputBudget}));
try {
  await service.wait(project.id);
  let p=service.get(project.id),r=p.run;
  facts.generation={status:r.status,error:r.error,actual:r.actualModel,calls:calls(r)};
  assert.equal(p.selectedVersion,original,'Generation must not replace user canvas');
  if(seed){
    assert.deepEqual(r.checkpoint.plan,prior.plan);
    assert.deepEqual(r.checkpoint.sections.slice(0,prior.sections.length),prior.sections);
    assert.ok(r.calls.slice(priorCalls).every(c=>c.key!=='plan'&&!Array.from({length:prior.sections.length},(_,i)=>`section-${i+1}`).includes(c.key)));
    facts.checkpointsReused=true;
  }
  assert.equal(r.status,'completed',r.error);
  const generated=p.versions.find(v=>v.id===r.resultVersion);
  service.store.select(p.id,generated.id);
  const targetId='site-section-1',before=selectedHtml(generated.doc,targetId);
  service.start(p.id,{baseVersion:generated.id,targetId,model:modelKey,
    instruction:'只把这个区块的最外层 inline style 增加 border-top: 4px solid #d35400。保留全部文字、子元素、id和现有属性，不修改其他内容。'});
  await service.wait(p.id);p=service.get(p.id);r=p.run;
  facts.edit={status:r.status,error:r.error,actual:r.actualModel,calls:calls(r)};
  assert.equal(r.status,'completed',r.error);
  assert.equal(p.selectedVersion,generated.id,'Edit candidate requires explicit adoption');
  const edited=p.versions.find(v=>v.id===r.resultVersion);
  assert.equal(edited.doc.css,generated.doc.css);
  assert.equal(edited.doc.html.replace(selectedHtml(edited.doc,targetId),''),generated.doc.html.replace(before,''));
  assert.notEqual(selectedHtml(edited.doc,targetId),before,'Requested edit must change the selected section');
  const element=html=>parseHTML(`<html><body>${html}</body></html>`).document.body.firstElementChild;
  const priorElement=element(before),nextElement=element(selectedHtml(edited.doc,targetId));
  assert.equal(nextElement.style.getPropertyValue('border-top').replace(/\s+/g,' ').trim(),'4px solid #d35400');
  assert.equal(nextElement.innerHTML,priorElement.innerHTML,'Selected children and text must remain unchanged');
  const attributes=el=>Object.fromEntries([...el.attributes].filter(a=>a.name!=='style').map(a=>[a.name,a.value]));
  assert.deepEqual(attributes(nextElement),attributes(priorElement),'Existing selected attributes must remain unchanged');
  const styles=el=>Object.fromEntries(Array.from({length:el.style.length},(_,i)=>el.style[i])
    .filter(key=>key!=='border-top').map(key=>[key,el.style.getPropertyValue(key)]));
  assert.deepEqual(styles(nextElement),styles(priorElement),'Other inline styles must remain unchanged');
  facts.edit.exactRequestedChange=true;
  service.store.select(p.id,edited.id);
  fs.writeFileSync(path.join(root,'delivery.html'),exportWebsite(edited.doc,p.title));
  facts.passed=true;
} catch(error){facts.failure=error.message;process.exitCode=1;}
finally{
  clearInterval(progress);
  facts.sourceUnchanged=seedFiles.every(({file,digest})=>hash(fs.readFileSync(file))===digest);
  if(!facts.sourceUnchanged){facts.passed=false;process.exitCode=1;}
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(facts,null,2));
  console.log(JSON.stringify(facts,null,2));
}
