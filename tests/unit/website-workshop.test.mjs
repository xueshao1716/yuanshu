import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = t => { const p=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-sites-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p; };
const document = () => ({html:'<main id="page"><section id="hero"><h1>原标题</h1></section><footer id="foot">保留</footer></main>',css:'body{margin:0} #hero{padding:40px}'});

test('website document removes executable markup and rejects unsafe CSS',async()=>{
  const {validateWebsite,exportWebsite}=await import('../../engine/website-document.mjs');
  const d=validateWebsite({html:'<h1 onclick="alert(1)">好</h1><script>alert(2)</script><iframe src="https://example.com"></iframe><a href="javascript:alert(3)">链接</a>',css:''});
  assert.doesNotMatch(d.html,/onclick|script|iframe|javascript/);
  assert.match(exportWebsite(d,'<标题>'),/viewport/);
  assert.doesNotMatch(exportWebsite(d,'<标题>'),/<title><标题>/);
  for(const css of ['@import "https://bad.test/a.css";','a{background:url(javascript:alert(1))}','a{color:red}</style><script>bad()</script>']) assert.throws(()=>validateWebsite({...document(),css}));
  assert.throws(()=>validateWebsite({html:'<script>bad()</script>',css:''}),/内容/);
});

test('website local patch preserves siblings and global CSS and requires same target',async()=>{
  const {patchWebsite}=await import('../../engine/website-document.mjs');
  const base=document(), next=patchWebsite(base,'hero',{html:'<section id="hero"><h1 style="color: red">新标题</h1></section>'});
  assert.match(next.html,/<footer id="foot">保留<\/footer>/);assert.equal(next.css,base.css);assert.match(base.html,/原标题/);
  assert.throws(()=>patchWebsite(base,'hero',{html:'<section id="other">改错了</section>'}),/选中/);
  assert.throws(()=>patchWebsite(base,'hero',{html:'<section id="hero">新的</section><footer>越界</footer>'}),/选中/);
  assert.throws(()=>patchWebsite(base,'missing',{html:'<section id="missing">坏</section>'}),/选中/);
});

test('website templates and store keep old designs isolated and versions immutable',async t=>{
  const {createWebsiteService}=await import('../../engine/website-service.mjs');
  const service=createWebsiteService({root:root(t)});
  assert.equal(service.templates.length,3);
  const p=service.create({title:'山野',brief:'徒步活动',template:'editorial'});
  assert.equal(p.versions.length,1);assert.ok(p.selectedVersion);assert.match(p.versions[0].doc.html,/山野/);
  const v=service.store.append(p.id,{doc:document(),parentId:p.selectedVersion});
  assert.notEqual(v.id,p.selectedVersion);assert.equal(service.get(p.id).selectedVersion,p.selectedVersion);
  assert.throws(()=>service.store.get('../bad'));
  assert.throws(()=>service.store.append(p.id,{doc:document(),parentId:'foreign'}));
});

test('website generation has actual stages and a single unselected candidate',async t=>{
  const {createWebsiteService}=await import('../../engine/website-service.mjs');
  const model={provider:'test',id:'designer'};let calls=0,seen;
  const s=createWebsiteService({root:root(t),getModelList:()=>[model],getDefaultModel:()=>model,directChat:async(m,msg,history)=>{calls++;seen={m,msg,history};return {text:JSON.stringify(document()),usedModel:{provider:'test',id:'actual'}};}});
  const p=s.create({title:'独立',brief:'本作品',template:'tech'}), selected=p.selectedVersion;
  s.start(p.id,{model:'test/designer',baseVersion:selected});await s.wait(p.id);
  const done=s.get(p.id);assert.equal(calls,1);assert.equal(done.versions.length,2);assert.equal(done.selectedVersion,selected);
  assert.equal(done.run.status,'completed');assert.ok(done.run.events.some(e=>e.stage==='validating'));
  assert.equal(done.versions[1].model.id,'actual');assert.equal(seen.history.length,0);assert.match(seen.msg,/本作品/);
  s.store.setRun(p.id,{status:'running',events:[]});assert.equal(s.get(p.id).run.status,'interrupted');
});

test('website selected generation only sends that subtree and preserves the rest',async t=>{
  const {createWebsiteService}=await import('../../engine/website-service.mjs');
  const model={provider:'test',id:'designer'};let prompt;
  const s=createWebsiteService({root:root(t),getDefaultModel:()=>model,directChat:async(m,msg)=>{prompt=msg;return {text:JSON.stringify({html:'<section id="hero"><h1>局部新标题</h1></section>'})};}});
  const p=s.create({title:'局部作品',brief:'公开需求',template:'tech'});
  const base=s.store.append(p.id,{doc:document(),parentId:p.selectedVersion});
  s.start(p.id,{baseVersion:base.id,targetId:'hero',instruction:'改标题'});await s.wait(p.id);
  const done=s.get(p.id),result=done.versions.at(-1);
  assert.equal(done.run.status,'completed');assert.match(prompt,/原标题/);assert.doesNotMatch(prompt,/<footer|id=\\"foot|body\{margin/);
  assert.equal(result.doc.css,base.doc.css);assert.match(result.doc.html,/<footer id="foot">保留<\/footer>/);
  assert.equal(result.parentId,base.id);assert.equal(done.selectedVersion,p.selectedVersion);
});

test('website export and sharing use only an owned version and remove temporary exports',async t=>{
  const {createWebsiteService}=await import('../../engine/website-service.mjs');
  const {handleWebsite}=await import('../../engine/website-routes.mjs');
  const workspace=root(t),s=createWebsiteService({root:workspace});
  const p=s.create({title:'导出验收',brief:'临时内容',template:'tech'});
  let status,payload,headers,html,shared;
  const json=(_res,code,data)=>{status=code;payload=data;},res={writeHead:(code,h)=>{status=code;headers=h;},end:data=>{html=data;}};
  await handleWebsite(s,json,res,'export',p.id,{versionId:p.selectedVersion});
  assert.equal(status,200);assert.match(headers['Content-Disposition'],/attachment/);assert.match(html,/导出验收/);
  await handleWebsite(s,json,res,'share',p.id,{versionId:p.selectedVersion,path:'C:/private.txt'},{root:workspace,share:async input=>{
    shared=input.path;assert.equal(path.dirname(shared),path.join(workspace,'workshop-out','website-exports'));
    assert.equal(fs.readFileSync(shared,'utf8'),html);return {details:{url:'https://example.test/test-page.html'}};
  }});
  assert.equal(status,200);assert.equal(payload.url,'https://example.test/test-page.html');assert.equal(fs.existsSync(shared),false);
  await handleWebsite(s,json,res,'share',p.id,{versionId:p.selectedVersion},{root:workspace,share:async input=>{shared=input.path;return {isError:true,text:'测试入口离线'};}});
  assert.equal(status,503);assert.equal(fs.existsSync(shared),false);
  await handleWebsite(s,json,res,'export',p.id,{versionId:'not-owned'});assert.equal(status,400);
});

test('website repair is bounded and cancellation never saves a late response',async t=>{
  const {createWebsiteService}=await import('../../engine/website-service.mjs');
  const model={provider:'test',id:'designer'};let calls=0;
  const s=createWebsiteService({root:root(t),getModelList:()=>[model],getDefaultModel:()=>model,directChat:async()=>{calls++;return {text:'broken'};}});
  const p=s.create({title:'失败',brief:'测试',template:'cinema'});s.start(p.id,{});await s.wait(p.id);
  assert.equal(calls,2);assert.equal(s.get(p.id).versions.length,1);assert.equal(s.get(p.id).run.status,'failed');
  assert.ok(s.get(p.id).run.events.some(e=>e.stage==='repairing'));
  let release;const slow=createWebsiteService({root:root(t),getModelList:()=>[model],getDefaultModel:()=>model,directChat:()=>new Promise(r=>{release=r;})});
  const q=slow.create({title:'取消',brief:'测试',template:'tech'});slow.start(q.id,{});await new Promise(r=>setImmediate(r));
  slow.cancel(q.id);release({text:JSON.stringify(document())});await slow.wait(q.id);
  assert.equal(slow.get(q.id).run.status,'cancelled');assert.equal(slow.get(q.id).versions.length,1);
});
