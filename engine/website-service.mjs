import {randomUUID} from 'node:crypto';
import {createUiDesignStore} from './ui-design-store.mjs';
import {designError,parseDesignReply} from './ui-design-document.mjs';
import {validateWebsite,selectedHtml,patchWebsite} from './website-document.mjs';
import {templateCatalogue,templateDocument} from './website-templates.mjs';

export function createWebsiteService(ctx) {
  const store=createUiDesignStore(ctx.root,{directory:'website-projects',validate:validateWebsite}),active=new Map();
  function get(id) {
    const p=store.get(id);
    if(p.run?.status==='running'&&!active.has(id)) return store.setRun(id,{...p.run,status:'interrupted',error:'服务重启中断了生成，已有版本保留。请重试。'});
    return p;
  }
  function create(input) {
    const doc=templateDocument(input?.template,input?.title||'我的网站',input?.brief||'');
    if(!doc) throw designError('请选择起步模板');
    const p=store.create(input);store.append(p.id,{doc,label:'起步模板'});return get(p.id);
  }
  function start(id,input={}) {
    if(active.has(id)) throw designError('本作品已有任务在运行',409);
    if(active.size>=3) throw designError('已有 3 个网页生成任务，请稍后再试',429);
    const p=get(id),base=p.versions.find(v=>v.id===(input.baseVersion||p.selectedVersion));
    if(!base) throw designError('版本不属于这个作品');
    const model=input.model?ctx.getModelList().find(m=>`${m.provider}/${m.id}`===input.model):ctx.getDefaultModel?.();
    if(!model) throw designError('请选择可用文本模型');
    const caps=Array.isArray(model.capabilities)?model.capabilities:Object.keys(model.capabilities||{}).filter(k=>model.capabilities[k]);
    if(caps.includes('image')||caps.includes('video')) throw designError('请选择文本模型');
    const target=String(input.targetId||''),instruction=String(input.instruction||'').trim().slice(0,3000);
    if(target&&!instruction) throw designError('请填写选区修改要求');
    const fragment=target?selectedHtml(base.doc,target):null;
    const controller=new AbortController(),run={id:randomUUID(),status:'running',startedAt:new Date().toISOString(),requestedModel:`${model.provider}/${model.id}`,events:[],error:null};
    const event=(stage,message)=>{run.stage=stage;run.events.push({stage,message,at:new Date().toISOString()});store.setRun(id,{...run});};
    event('preparing',target?'已锁定选区，其余页面保持不变':'已读取本作品需求和当前页面');
    const task={controller,run,promise:null};active.set(id,task);
    task.promise=Promise.resolve().then(async()=>{
      try {
        const systemHint='你是专业网站设计师。只返回 JSON，不要 Markdown、说明或工具调用。静态单页，只用语义 HTML 与 CSS，不用 JS、SVG、iframe、表单、外部 CSS、@import。图片只用 HTTPS 或已有图片，不编造本地路径。保留中文内容、移动端适配、足够对比度、prefers-reduced-motion。最多四个主要区块，控制输出在 6000 tokens 内。'+(target?'返回 {"html":"选中元素完整HTML"}，只修改给出的选区，必须保留根元素 id；样式仅用 inline style，不返回 CSS，不修改祖先或兄弟元素。':'返回 {"html":"body 内的完整内容","css":"完整样式"}，不含 html/head/body/style 标签。保留已有内容和设计方向，按要求优化，不随意退回通用模板。');
        let message=systemHint+'\n本作品资料：'+JSON.stringify({title:p.title,brief:p.brief,references:p.references,instruction:instruction||'依照本作品需求完成网站设计',...(target?{targetId:target,selectedHtml:fragment}:{current:base.doc})});
        let result,doc;
        for(let attempt=0;attempt<2;attempt++) {
          if(controller.signal.aborted) throw controller.signal.reason;
          event(attempt?'repairing':'generating',attempt?'返回内容未通过校验，正在请求同一模型修正一次':'请求已发送，等待模型返回设计内容');
          const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(125000)]);
          // Race the signal as well: a misbehaving adapter must not pin the task forever.
          let abort;const aborted=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
          try {result=await Promise.race([ctx.directChat(model,message,[],{systemHint,timeout:120000,signal,thinking:false,maxTokens:8192,throwOnError:true}),aborted]);}
          finally {signal.removeEventListener('abort',abort);}
          if(controller.signal.aborted) throw controller.signal.reason;
          if(result?.timeout) throw designError('模型响应超时，已有内容保留',504);
          event('validating','已收到模型内容，正在检查结构、样式和修改范围');
          try {const answer=parseDesignReply(result?.text);doc=target?patchWebsite(base.doc,target,answer):validateWebsite(answer);break;}
          catch(error) {if(attempt)throw error;message+='\n上次结果有误：'+error.message+'。请修正后返回完整 JSON。上次结果：'+String(result?.text||'').slice(0,100000);}
        }
        if(controller.signal.aborted) throw controller.signal.reason;
        const version=store.append(id,{doc,label:target?`局部：${instruction.slice(0,30)}`:'AI 页面候选',parentId:base.id,model:result.usedModel||model});
        run.resultVersion=version.id;run.status='completed';event('completed','候选版本已保存，点击「采用此版本」后才会替换画布');
      } catch(error) {
        run.status=controller.signal.aborted?'cancelled':'failed';
        run.error=controller.signal.aborted?'已停止，原页面和版本保留':error.name==='TimeoutError'?'等待模型超时，原页面保留，可重试':error.statusCode?error.message:'生成失败，原页面保留，请检查模型通道后重试';
      } finally {run.finishedAt=new Date().toISOString();try{store.setRun(id,{...run});}finally{active.delete(id);}}
    });
    task.promise.catch(()=>{});return {...run};
  }
  function cancel(id) {get(id);const t=active.get(id);if(t){t.controller.abort(new Error('用户停止'));t.run.status='cancelled';t.run.error='已停止，原页面和版本保留';store.setRun(id,{...t.run});}return get(id);}
  return {store,get,create,start,cancel,templates:templateCatalogue(),wait:id=>active.get(id)?.promise||Promise.resolve()};
}
