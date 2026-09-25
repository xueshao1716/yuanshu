import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createWebsiteService} from '../engine/website-service.mjs';
import {websiteRoutes} from '../engine/website-routes.mjs';
import {validatePlan,validateSection,assembleSections} from '../engine/website-sections.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-website-browser-'));
const model={provider:'test',id:'designer',name:'验证模型'};
let fail=true,sectionOneCalls=0;
const service=createWebsiteService({root,getModelList:()=>[model],getDefaultModel:()=>model,directChat:async(m,message,history,opts)=>{
  await new Promise(r=>setTimeout(r,1800));
  if(opts.systemHint.includes('先做设计计划'))return {text:JSON.stringify({direction:'自然编辑排版',css:'body{margin:0;font-family:system-ui}',sections:[{title:'开场',brief:'欢迎'},{title:'故事',brief:'内容'}]}),usedModel:model};
  const index=JSON.parse(message).index;
  if(index===1)sectionOneCalls++;
  if(index===2&&fail)throw Object.assign(new Error('验收用可恢复通道错误'),{statusCode:502});
  return {text:JSON.stringify({html:`<section id="site-section-${index}"><h1>原创区块 ${index}</h1><p>从想法开始的页面</p></section>`,css:`section{padding:32px;background:#edf2e8}h1{color:#26432b}h1::before{content:"· "}@media(max-width:600px){h1{font-size:24px}}`}),usedModel:model};
}});
const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const routes=websiteRoutes(service,{root,json,readBody:async req=>{let body='';for await(const chunk of req)body+=chunk;return JSON.parse(body||'{}');}});
const dist=path.resolve(process.env.YUANSHU_VERIFY_DIST||'tmp/verification-dist');
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    for(const [method,pattern,handler] of routes){const match=typeof pattern==='string'?url.pathname===pattern:url.pathname.match(pattern);if(req.method===method&&match)return await handler(res,req,url,match);}
    if(url.pathname.startsWith('/api/'))return json(res,200,url.pathname==='/api/models'?{models:[model],current:'test/designer',cwd:root}:url.pathname==='/api/sessions'?{sessions:[]}:{ok:true});
    const file=path.join(dist,url.pathname==='/'?'index.html':decodeURIComponent(url.pathname));
    if(!file.startsWith(dist)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream'});fs.createReadStream(file).pipe(res);
  }catch(e){json(res,500,{error:e.message});}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${server.address().port}/#/workshop`;
const browser=await chromium.launch({headless:true});
const errors=[];
try{
  for(const [device,width,height] of [['desktop',1440,1050],['mobile',390,844]]){
    fail=true;const startCalls=sectionOneCalls;
    const context=await browser.newContext({viewport:{width,height}});
    await context.addInitScript(()=>{if(window===window.top){localStorage.setItem('yuanshu_access_token','fixture');localStorage.setItem('pi_workshop_tab','ui');}});
    let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);
    await page.getByLabel('描述你的想法').fill('验收用自然主题网站 '+device);
    await page.getByRole('button',{name:'开始 AI 设计',exact:true}).click();
    await page.locator('.site-run').getByText('AI 正在设计',{exact:true}).waitFor();
    const id=service.store.list().find(p=>p.title.includes(device)).id;
    const original=service.get(id).selectedVersion;
    await page.locator('.site-run').screenshot({path:`${root}/website-${device}-progress.png`});
    await page.reload();
    await page.getByRole('button',{name:'继续本次任务',exact:true}).waitFor({timeout:30000});
    assert.equal(service.get(id).selectedVersion,original);
    assert.equal(service.get(id).run.checkpoint.sections.length,1);
    fail=false;await page.getByRole('button',{name:'继续本次任务',exact:true}).click();
    await page.getByRole('button',{name:'查看候选页面',exact:true}).waitFor({timeout:30000});
    assert.equal(sectionOneCalls,startCalls+1);
    assert.equal(service.get(id).selectedVersion,original);
    await page.getByRole('button',{name:'查看候选页面',exact:true}).click();
    await page.frameLocator('iframe[title="独立网页预览"]').getByText('原创区块 2',{exact:true}).waitFor();
    await page.screenshot({path:`${root}/website-${device}-candidate.png`});
    await page.getByRole('button',{name:'采用此版本',exact:true}).click();
    await page.getByText('已采用此版本；原版本仍可找回',{exact:true}).waitFor();
    assert.notEqual(service.get(id).selectedVersion,original);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
    assert.equal(overflow,false,`${device} horizontal overflow`);
    await page.screenshot({path:`${root}/website-${device}-adopted.png`});
    await context.close();
    console.log(JSON.stringify({device,progress:true,reload:true,resume:true,noRepeatedSection:true,explicitAdopt:true,overflow:false}));
  }
  const page=await browser.newPage();
  const plan=validatePlan({direction:'test',css:'',sections:[{title:'x',brief:'x'}]});
  const section=validateSection({html:'<section id="site-section-1"><h1>Title</h1></section>',css:'section{background-color:rgb(1,2,3)}h1{color:rgb(4,5,6);animation:pulse 2s infinite}h1::before{content:"yes"}@keyframes pulse{from{opacity:1}to{opacity:.9}}@media(min-width:600px){h1{font-size:33px}}'},1,plan,[]);
  const doc=assembleSections(plan,[section]);await page.setContent(`<style>${doc.css}</style>${doc.html}<section id="sibling"><h1>Sibling</h1></section>`);
  const styles=await page.evaluate(()=>{const h=document.querySelector('#site-section-1 h1');return {root:getComputedStyle(h.parentElement).backgroundColor,color:getComputedStyle(h).color,pseudo:getComputedStyle(h,'::before').content,font:getComputedStyle(h).fontSize,animation:getComputedStyle(h).animationName,sibling:getComputedStyle(document.querySelector('#sibling h1')).color};});
  assert.deepEqual(styles,{root:'rgb(1, 2, 3)',color:'rgb(4, 5, 6)',pseudo:'"yes"',font:'33px',animation:'site-section-1-pulse',sibling:'rgb(0, 0, 0)'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({cssScoping:styles,pageErrors:errors,root}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
