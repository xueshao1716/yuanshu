import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWebsiteService} from '../../engine/website-service.mjs';

const model={provider:'test',id:'designer',maxTokens:32768};
const plan={direction:'纸张与鲜红点缀，按内容安排版式',css:'body{margin:0;background:#fff;color:#111}',sections:[{title:'开篇',brief:'独特大标题'},{title:'故事',brief:'不规则双栏'}]};
const part=i=>({html:`<section id="site-section-${i}"><h1>作品${i}</h1></section>`,css:'h1{font-size:48px}'});
const roots=new WeakMap();
function setup(t,call){const root=fs.mkdtempSync(path.join(os.tmpdir(),'yuanshu-ai-first-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const s=createWebsiteService({root,getModelList:()=>[model],getDefaultModel:()=>model,directChat:call});roots.set(s,root);return s;}

test('idea alone starts creative planning, section generation and unselected candidate',async t=>{
  const prompts=[],answers=[plan,part(1),part(2)];
  const s=setup(t,async(m,msg,h,opts)=>{prompts.push({msg,opts});return {text:JSON.stringify(answers.shift()),usedModel:{provider:'test',id:'actual'}};});
  const p=s.create({brief:'摩托车文化，不要模板感',model:'test/designer'});
  assert.equal(p.run.status,'running');assert.ok(p.title);assert.equal(p.versions.length,1);
  await s.wait(p.id);const done=s.get(p.id);
  assert.equal(done.run.status,'completed');assert.equal(done.versions.length,2);assert.equal(done.selectedVersion,p.selectedVersion);
  assert.equal(prompts.length,3);assert.doesNotMatch(prompts[0].msg,/"current"|最多四个|6000 tokens/);
  assert.ok(prompts.every(p=>p.opts.allowPartial&&p.opts.maxTokens>8192));
  assert.equal(done.run.checkpoint.sections.length,2);assert.equal(done.run.calls.length,3);
  assert.match(done.versions[1].doc.html,/作品1[\s\S]*作品2/);assert.match(done.versions[1].doc.css,/site-section-1/);
});

test('optional template is reference only for creative mode',async t=>{
  let first,hint;const answers=[plan,part(1),part(2)];
  const s=setup(t,async(m,msg,h,opts)=>{first??=msg;hint??=opts.systemHint;return {text:JSON.stringify(answers.shift())};});
  const p=s.create({title:'主题',brief:'自由设计',template:'editorial',generate:true});await s.wait(p.id);
  assert.match(hint,/参考模板仅作可选灵感/);assert.match(first,/optionalReference/);assert.doesNotMatch(first,/"current"/);assert.equal(s.get(p.id).run.status,'completed');
});

test('truncated response is checkpointed and continued once without losing prefix',async t=>{
  const full=JSON.stringify(part(1)),cut=full.length-20;let calls=0,sawCheckpoint=false;
  const s=setup(t,async(m,msg,h)=>{calls++;if(calls===1)return {text:JSON.stringify({...plan,sections:plan.sections.slice(0,1)})};
    if(calls===2)return {text:full.slice(0,cut),truncated:true,outputBudget:16384};
    const checkpoint=s.get(p.id).run.checkpoint;sawCheckpoint=checkpoint.partial.text===full.slice(0,cut);
    assert.equal(h.at(-1).content,full.slice(0,cut));return {text:full.slice(cut)};
  });
  const p=s.create({brief:'续写测试'});await s.wait(p.id);const done=s.get(p.id);
  assert.equal(calls,3);assert.equal(sawCheckpoint,true);assert.equal(done.run.status,'completed');
  assert.ok(done.run.events.some(e=>e.stage==='recovering'));
});

test('failed section resumes from persisted checkpoint without rerunning completed sections',async t=>{
  let calls=0;const s=setup(t,async()=>{calls++;if(calls===1)return {text:JSON.stringify(plan)};if(calls===2)return {text:JSON.stringify(part(1))};throw Object.assign(new Error('通道暂时失败'),{statusCode:502});});
  const p=s.create({brief:'检查点测试'});await s.wait(p.id);
  const failed=s.get(p.id);assert.equal(failed.run.status,'failed');assert.equal(failed.run.checkpoint.sections.length,1);assert.equal(failed.versions.length,1);
  // Same on-disk store, new service: simulates a restart, not an in-memory shortcut.
  let resumedCalls=0;
  const next=createWebsiteService({root:roots.get(s),getModelList:()=>[model],directChat:async()=>{resumedCalls++;return {text:JSON.stringify(part(2))};}});
  const resume=next.start(p.id,{resume:true});assert.equal(resume.status,'running');await next.wait(p.id);
  assert.equal(resumedCalls,1,'only unfinished section is requested again');
  assert.equal(next.get(p.id).run.status,'completed');assert.equal(next.get(p.id).run.checkpoint.sections.length,2);assert.equal(next.get(p.id).selectedVersion,p.selectedVersion);
  assert.equal(next.get(p.id).run.calls.length,4,'resume retains earlier model call facts');
  assert.equal(next.get(p.id).run.resumedFrom,failed.run.id);
});

test('oversized continuation preserves last safe checkpoint instead of growing without bound',async t=>{
  let calls=0;const chunk='x'.repeat(400000);
  const s=setup(t,async()=>{calls++;return {text:chunk,truncated:true,outputBudget:32768};});
  const p=s.create({brief:'检查片段大小边界'});await s.wait(p.id);const done=s.get(p.id);
  assert.equal(calls,2);assert.equal(done.run.status,'failed');assert.equal(done.versions.length,1);
  assert.equal(done.run.checkpoint.partial.text.length,chunk.length);assert.ok(done.run.checkpoint.partial.text===chunk);assert.match(done.run.error,/安全范围/);
});

test('persistent truncation is bounded and never saved as a successful page',async t=>{
  let calls=0;const s=setup(t,async()=>{calls++;return {text:'{"direction":"partial',truncated:true,outputBudget:32768};});
  const p=s.create({brief:'永远截断'});await s.wait(p.id);const done=s.get(p.id);
  assert.equal(calls,2);assert.equal(done.run.status,'failed');assert.equal(done.versions.length,1);assert.ok(done.run.checkpoint.partial.text.length);
});

test('cancelled creative task never saves late sections and invalid models create no orphan',async t=>{
  let release;const s=setup(t,()=>new Promise(r=>{release=r;}));
  assert.throws(()=>s.create({brief:'没有模型',model:'bad/nope'}),/模型/);assert.equal(s.store.list().length,0);
  const p=s.create({brief:'取消'});await new Promise(r=>setImmediate(r));s.cancel(p.id);release({text:JSON.stringify(plan)});await s.wait(p.id);
  assert.equal(s.get(p.id).run.status,'cancelled');assert.equal(s.get(p.id).versions.length,1);
});

test('resuming does not attribute an unanswered request to the previous successful model',async t=>{
  let calls=0;const s=setup(t,async()=>{if(++calls===1)return {text:JSON.stringify(plan),usedModel:{provider:'test',id:'actual'}};return {timeout:true};});
  const p=s.create({brief:'模型事实'});await s.wait(p.id);
  const failed=s.get(p.id).run;
  assert.equal(failed.actualModel,undefined,'latest timed out call has no confirmed model');
  assert.equal(failed.lastSuccessfulModel,'test/actual');
  const resumed=s.start(p.id,{resume:true});assert.equal(resumed.actualModel,undefined);assert.equal(resumed.lastSuccessfulModel,'test/actual');
  await s.wait(p.id);assert.equal(s.get(p.id).run.actualModel,undefined);
});

test('stream interruption saves answer only and resumes the unfinished JSON',async t=>{
  const full=JSON.stringify({...plan,sections:plan.sections.slice(0,1)}),prefix=full.slice(0,40);let calls=0;
  const s=setup(t,async(m,msg,history,opts)=>{
    calls++;
    if(calls===1){assert.equal(opts.stream,true);opts.onProgress({phase:'thinking',thinkingCharacters:25,characters:0});opts.onDelta(prefix);throw Object.assign(new Error('模型流中断'),{statusCode:502});}
    if(calls===2){assert.equal(history.at(-1).content,prefix);return {text:full.slice(40),usedModel:model};}
    return {text:JSON.stringify(part(1)),usedModel:model};
  });
  const p=s.create({brief:'断流'});await s.wait(p.id);let result=s.get(p.id);
  assert.equal(result.run.checkpoint.partial?.text,prefix);assert.equal(result.versions.length,1);
  assert.equal(result.run.progress.thinkingCharacters,25);assert.ok(!JSON.stringify(result.run).includes('reasoning_content'));
  s.start(p.id,{resume:true});await s.wait(p.id);result=s.get(p.id);
  assert.equal(result.run.status,'completed');assert.equal(calls,3);assert.equal(result.selectedVersion,p.selectedVersion);
});
