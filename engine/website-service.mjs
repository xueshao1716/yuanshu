import {randomUUID} from 'node:crypto';
import {createUiDesignStore} from './ui-design-store.mjs';
import {designError} from './ui-design-document.mjs';
import {validateWebsite,selectedHtml,escapeHtml} from './website-document.mjs';
import {templateCatalogue,templateDocument} from './website-templates.mjs';
import {generateWebsite} from './website-generation.mjs';

export function createWebsiteService(ctx) {
  const store=createUiDesignStore(ctx.root,{directory:'website-projects',validate:validateWebsite}),active=new Map();
  function get(id) {
    const p=store.get(id);
    if(p.run?.status==='running'&&!active.has(id)) return store.setRun(id,{...p.run,status:'interrupted',error:'服务重启中断了生成，已有版本和检查点保留。可继续本次任务。'});
    return p;
  }
  function pickModel(key) {
    const model=key?ctx.getModelList?.().find(m=>`${m.provider}/${m.id}`===key):ctx.getDefaultModel?.();
    if(!model)throw designError('请选择可用文本模型');
    const caps=Array.isArray(model.capabilities)?model.capabilities:Object.keys(model.capabilities||{}).filter(k=>model.capabilities[k]);
    if(caps.includes('image')||caps.includes('video'))throw designError('请选择文本模型');
    return model;
  }
  function capacity(id) {
    if(active.has(id))throw designError('本作品已有任务在运行',409);
    if(active.size>=3)throw designError('已有 3 个网页生成任务，请稍后再试',429);
  }
  function create(input={}) {
    const title=String(input.title||input.brief||'我的网站').trim().slice(0,100);
    const reference=input.template?templateDocument(input.template,title,input.brief||''):null;
    if(input.template&&!reference)throw designError('参考模板不存在');
    // Legacy callers can still explicitly create an editable template without a model.
    const auto=input.generate===true||(!input.template&&input.generate!==false);
    if(auto){capacity();pickModel(input.model);}
    const doc=reference||{html:`<main id="site-draft"><h1>${escapeHtml(title)}</h1><p>AI 候选页面将在完成后供你预览和采用。</p></main>`,css:'body{margin:0;padding:40px;font-family:system-ui;line-height:1.6}'};
    const p=store.create({...input,title});store.append(p.id,{doc,label:reference?'参考模板':'创作起点'});
    if(auto)start(p.id,{model:input.model,mode:'creative',reference:reference?{name:input.template,doc:reference}:null});
    return get(p.id);
  }
  function start(id,input={}) {
    capacity(id);
    const p=get(id),previous=p.run;
    if(input.resume&&(!previous?.checkpoint||!previous.request||previous.status==='completed'))throw designError('没有可继续的检查点');
    const request=input.resume?structuredClone(previous.request):{
      mode:input.mode==='creative'?'creative':'edit',baseVersion:input.baseVersion||p.selectedVersion,
      targetId:String(input.targetId||''),instruction:String(input.instruction??'').trim().slice(0,3000),reference:input.reference||null,
    };
    const base=p.versions.find(v=>v.id===request.baseVersion);
    if(!base)throw designError('版本不属于这个作品');
    const model=pickModel(input.resume?previous.requestedModel:input.model);
    if(request.targetId&&!request.instruction)throw designError('请填写选区修改要求');
    request.instruction||='依照本作品需求完成网站设计';
    const fragment=request.targetId?selectedHtml(base.doc,request.targetId):null;
    const controller=new AbortController(),run={id:randomUUID(),status:'running',startedAt:new Date().toISOString(),requestedModel:`${model.provider}/${model.id}`,request,
      checkpoint:input.resume?structuredClone(previous.checkpoint):{plan:null,sections:[],partial:null},calls:input.resume?structuredClone(previous.calls||[]):[],events:[],error:null,
      ...(input.resume?{resumedFrom:previous.id,actualModel:previous.actualModel}:{} )};
    const event=(stage,message)=>{run.stage=stage;run.events.push({stage,message,at:new Date().toISOString()});store.setRun(id,{...run});};
    event('preparing',input.resume?'从已保存的检查点继续，已完成区块不会重跑':request.targetId?'已锁定选区，其余页面保持不变':request.mode==='creative'?'已收到想法，开始原创设计':'已读取本作品需求和当前页面');
    const task={controller,run,promise:null};active.set(id,task);
    task.promise=Promise.resolve().then(async()=>{
      try {
        const result=await generateWebsite({ctx,model,project:p,base,fragment,run,event,controller});
        controller.signal.throwIfAborted();
        const version=store.append(id,{doc:result.doc,label:request.targetId?`局部：${request.instruction.slice(0,30)}`:'AI 页面候选',parentId:base.id,model:result.usedModel});
        run.resultVersion=version.id;run.status='completed';event('completed','候选版本已保存，点击「采用此版本」后才会替换画布');
      } catch(error) {
        run.status=controller.signal.aborted?'cancelled':'failed';
        run.error=controller.signal.aborted?'已停止，原页面和检查点保留':error.name==='TimeoutError'?'等待模型超时，原页面和检查点保留，可继续':error.statusCode?error.message:'生成失败，原页面和检查点保留，请检查模型通道后重试';
      } finally {run.finishedAt=new Date().toISOString();try{store.setRun(id,{...run});}finally{active.delete(id);}}
    });
    task.promise.catch(()=>{});return {...run};
  }
  function cancel(id) {get(id);const t=active.get(id);if(t){t.controller.abort(new Error('用户停止'));t.run.status='cancelled';t.run.error='已停止，原页面和检查点保留';store.setRun(id,{...t.run});}return get(id);}
  return {store,get,create,start,cancel,templates:templateCatalogue(),wait:id=>active.get(id)?.promise||Promise.resolve()};
}
