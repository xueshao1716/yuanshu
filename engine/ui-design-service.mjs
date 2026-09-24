import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createUiDesignStore } from './ui-design-store.mjs';
import { designError, mergeGroup, parseDesignReply, validateDocument } from './ui-design-document.mjs';

const upstreamGuide = fs.readFileSync(new URL('../public/workshop-ui/agent.md',import.meta.url),'utf8');
const guide = upstreamGuide.slice(upstreamGuide.indexOf('## The document'), upstreamGuide.indexOf('## Checklist'));
export function createUiDesignService(ctx) {
  const store=createUiDesignStore(ctx.root), active=new Map();
  function get(id) {
    const p=store.get(id);
    if(p.run?.status==='running' && !active.has(id)) return store.setRun(id,{...p.run,status:'interrupted',error:'服务重启中断了生成；已有版本保留，可重新生成'});
    return p;
  }
  function start(id,input={}) {
    if(!input || typeof input!=='object' || Array.isArray(input)) throw designError('作品参数格式错误');
    if(active.has(id)) throw designError('此作品正在进行生成，请等待完成',409);
    if(active.size>=3) throw designError('工坊已有 3 个生成任务，请稍后再试',429);
    const p=get(id),list=ctx.getModelList(),key=String(input.model||'');
    const model=key ? list.find(m=>`${m.provider}/${m.id}`===key) : (ctx.getDefaultModel?.() || ctx.defaultModel);
    if(!model) throw designError('所选模型不可用，请重新选择');
    const caps=Array.isArray(model.capabilities)?model.capabilities:Object.keys(model.capabilities||{}).filter(k=>model.capabilities[k]);
    if(caps.includes('image') || caps.includes('video')) throw designError('请选择文本模型生成界面');
    const base=input.baseVersion ? p.versions.find(v=>v.id===input.baseVersion) : null;
    if(input.baseVersion && !base) throw designError('版本不属于这个作品');
    const groupId=String(input.groupId||''),instruction=String(input.instruction||'').trim().slice(0,3000);
    if(groupId && (!base || !base.doc.groups.some(g=>g.id===groupId) || !instruction)) throw designError('请选择要修改的组件并填写修改要求');
    const run={id:randomUUID(),status:'running',completed:0,total:groupId?1:2,startedAt:new Date().toISOString(),requestedModel:key||`${model.provider}/${model.id}`,error:null};
    store.setRun(id,run);
    const promise=Promise.resolve().then(async()=>{
      try {
        let previousDirection;
        for(let i=0;i<run.total;i++) {
          const direction=i===0?'方向 A：简洁、信息层级清楚，主要操作突出。':'方向 B：突出内容浏览，采用与方向 A 不同的信息布局和配色。';
          const systemHint=groupId
            ? '你是界面草图编辑器。只返回 JSON {"group":修改后的组件组}。保持 group.id 不变，不能改变其他组或屏幕。使用原格式。'
            : `你是界面草图设计师。只返回完整 M3E JSON，不要链接、Markdown 或说明。使用中文和真实需求，最多两个屏幕。下文是格式参考（交付要求以上文为准）：\n${guide}`;
          // Carry the contract in input too: some Responses adapters omit systemHint.
          let message=systemHint+'\n本作品需求：\n'+JSON.stringify({title:p.title,brief:p.brief,references:p.references,
            request:groupId?instruction:direction, ...(base?{base:base.doc}:{}), ...(groupId?{groupId}:{}), ...(previousDirection?{previousDirection}:{})});
          let result,doc;
          for(let attempt=0;attempt<2;attempt++) {
            result=await ctx.directChat(model,message,[],{systemHint,timeout:120000,signal:AbortSignal.timeout(125000),thinking:false,maxTokens:8192,throwOnError:true});
            if(result?.timeout) throw designError('模型响应超时；已完成的方向保留，可重新生成',504);
            try {
              const answer=parseDesignReply(result?.text);
              doc=groupId?mergeGroup(base.doc,groupId,answer):validateDocument(answer);
              break;
            } catch(error) {
              if(attempt || !result?.text || !error.statusCode) throw error;
              // One same-model repair only; never save invalid output or change models.
              message+='\n上次输出未通过结构校验：'+error.message+'。请修正并重新返回完整 JSON。上次输出：\n'+result.text.slice(0,150000);
            }
          }
          previousDirection=doc;
          store.append(id,{doc,label:groupId?`局部修改：${instruction.slice(0,35)}`:direction.split('：')[0],parentId:base?.id||null,model:result.usedModel||model});
          run.completed++;store.setRun(id,{...run});
        }
        run.status='completed';
      } catch(error) {
        run.status=run.completed?'partial':'failed';
        run.error=error.statusCode?error.message:'生成失败，请稍后重试；原版本已保留';
      } finally {
        run.finishedAt=new Date().toISOString();
        try {store.setRun(id,{...run});} finally {active.delete(id);}
      }
    });
    active.set(id,promise);promise.catch(()=>{});
    return {...run};
  }
  return {store,get,start,wait:id=>active.get(id)||Promise.resolve()};
}

export async function handleUiDesign(service,json,res,action,id,input={}) {
  try {
    if(!input || typeof input!=='object' || Array.isArray(input)) throw designError('作品参数格式错误');
    if(action==='list') return json(res,200,{projects:service.store.list()});
    if(action==='create') return json(res,201,service.store.create(input));
    if(action==='get') return json(res,200,service.get(id));
    if(action==='save') return json(res,201,service.store.append(id,{doc:input.doc,label:input.label,parentId:input.parentId}));
    if(action==='select') return json(res,200,service.store.select(id,input.versionId));
    if(action==='generate') return json(res,202,service.start(id,input));
    throw designError('未知工坊操作',404);
  } catch(error) { return json(res,error.statusCode||500,{error:error.statusCode?error.message:'作品读写失败，请稍后重试'}); }
}
