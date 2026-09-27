import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {initModelClient,directChat} from '../engine/model-client.mjs';
import {createWebsiteService} from '../engine/website-service.mjs';
import {exportWebsite} from '../engine/website-document.mjs';
const readJsonFile=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const agentDir=path.join(os.homedir(),'.pi','agent'),authPath=path.join(agentDir,'auth.json'),modelsPath=path.join(agentDir,'models-store.json');
const auth=readJsonFile(authPath),store=readJsonFile(modelsPath);
const token=fs.readFileSync('.token','utf8').trim();
const catalogue=await (await fetch('http://127.0.0.1:8787/api/models',{headers:{Authorization:`Bearer ${token}`}})).json();
const modelKey=process.argv[2]||'stepfun-plan/step-5-preview';
const model=catalogue.models.find(m=>`${m.provider}/${m.id}`===modelKey);
assert.ok(model);
initModelClient({readJsonFile,authPath,modelsPath,resolveAuth:p=>auth[p]?.key?{key:auth[p].key,baseUrl:auth[p].baseUrl||''}:null,getModelList:()=>catalogue.models});
const liveRoot='D:/pi-workspace/workshop-out/website-projects';
const snapshot=()=>fs.existsSync(liveRoot)?fs.readdirSync(liveRoot,{recursive:true}).sort().flatMap(p=>{const f=path.join(liveRoot,p);return fs.statSync(f).isFile()?[[p,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]]:[]}):[];
const resumeRoot=process.argv[3],repairMobile=process.argv[4]==='repair-mobile';
const before=snapshot(),root=resumeRoot||fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-website-real-'));
const service=createWebsiteService({root,getModelList:()=>[model],getDefaultModel:()=>model,directChat});
const project=resumeRoot?service.get(service.store.list()[0].id):service.create({title:'临海书店 · 真实通道验收',brief:'设计一家海边独立书店的中文单页。只需2个区块：一个有鲜明字体层级的开场和一个三本推荐书的网格。克制的海蓝与奶油白，原创布局，不用图片。每区块只写必要内容，纯HTML/CSS，手机也能看。',model:modelKey});
const original=project.selectedVersion;
const priorPlan=project.run.checkpoint.plan;
const beforeDoc=repairMobile?project.versions.find(v=>v.id===project.run.resultVersion).doc:null;
if(repairMobile)service.start(project.id,{baseVersion:project.run.resultVersion,model:modelKey,targetId:'s1-wave',instruction:'实测手机390px宽时，本装饰元素 s1-wave 的负边距与外层20px padding不匹配，横向超出屏幕。仅修这个装饰元素：用内联 margin:0; width:100%; max-width:100%; box-sizing:border-box 约束在父级内容宽内。保留原有id和标签，不增加文字，不改其他内容。'});
else if(resumeRoot)service.start(project.id,{resume:true});
let last='';const timer=setInterval(()=>{const p=service.get(project.id),r=p.run;const s=JSON.stringify({status:r.status,stage:r.stage,saved:r.checkpoint.sections.length,total:r.checkpoint.plan?.sections.length});if(s!==last){console.log(s);last=s;}},3000);
try {
 await service.wait(project.id);const p=service.get(project.id),r=p.run;
 assert.deepEqual(snapshot(),before,'real user website files unchanged');
 assert.equal(p.selectedVersion,original);
 if(resumeRoot&&!repairMobile){assert.deepEqual(r.checkpoint.plan,priorPlan);assert.equal(r.calls.filter(c=>c.key==='plan').length,1);}
 if(repairMobile&&r.resultVersion){const afterDoc=p.versions.find(v=>v.id===r.resultVersion).doc;assert.equal(afterDoc.css,beforeDoc.css);const strip=s=>s.replace(/<div id="s1-wave"[^>]*><\/div>/,'');assert.equal(strip(afterDoc.html),strip(beforeDoc.html),'other elements unchanged');}
 const facts={requested:modelKey,actual:r.actualModel,status:r.status,error:r.error,sections:r.checkpoint.sections.length,resumed:!!resumeRoot&&!repairMobile,planReused:resumeRoot&&!repairMobile?true:undefined,selectedRepair:repairMobile,calls:r.calls.map(c=>({key:c.key,runId:c.runId,usedModel:c.usedModel,finishReason:c.finishReason,truncated:c.truncated,budget:c.outputBudget,characters:c.characters,failed:c.failed})),liveFilesUnchanged:true,root};
 const stem=`.verification/website-real-${model.provider}${repairMobile?'-mobile-fixed':resumeRoot?'-resumed':''}`;
 fs.writeFileSync(stem+'.json',JSON.stringify(facts,null,2));
 if(r.resultVersion){const v=p.versions.find(v=>v.id===r.resultVersion);fs.writeFileSync(stem+'.html',exportWebsite(v.doc,p.title));}
 console.log(JSON.stringify(facts));assert.equal(r.status,'completed');
}finally{clearInterval(timer);}
