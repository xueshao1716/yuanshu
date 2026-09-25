import {designError,parseDesignReply} from './ui-design-document.mjs';
import {validateWebsite,patchWebsite} from './website-document.mjs';
import {clampOutputTokens,escalateOutputTokens} from './output-budget.mjs';
import {websiteRules,validatePlan,validateSection,assembleSections} from './website-sections.mjs';

// All recovery is bounded: one continuation and one structural repair per unit.
export async function generateWebsite({ctx,model,project,base,fragment,run,event,controller}) {
  const cp=run.checkpoint,request=run.request;
  const overall=AbortSignal.any([controller.signal,AbortSignal.timeout(15*60*1000)]);
  let lastModel=run.calls.findLast(f=>f.usedModel)?.usedModel||model;
  async function call(message,history,systemHint,budget,key,prefix='') {
    overall.throwIfAborted();
    const signal=AbortSignal.any([overall,AbortSignal.timeout(305000)]);
    const fact={key,runId:run.id,requestedModel:`${model.provider}/${model.id}`,startedAt:new Date().toISOString(),outputBudget:budget};
    run.calls.push(fact);
    delete run.actualModel;
    run.progress={phase:'waiting',characters:0,thinkingCharacters:0};
    event('waiting','请求已发送，等待模型开始返回；上次成功模型不代表本次实际模型');
    let streamed='',savedAt=0,lastPhase='waiting';
    const saveProgress=(force=false)=>{
      if(!force && Date.now()-savedAt<2000 && run.progress.phase===lastPhase)return;
      savedAt=Date.now();lastPhase=run.progress.phase;
      const labels={waiting:'等待模型返回',thinking:'模型正在思考',output:'正在接收页面内容'};
      event(lastPhase,`${labels[lastPhase]||'模型响应中'} · 正文 ${run.progress.characters} 字符 · 思考 ${run.progress.thinkingCharacters} 字符`);
    };
    const onDelta=delta=>{
      signal.throwIfAborted();
      if(prefix.length+streamed.length+delta.length>700000)throw designError('单个区块超出 70 万字符安全范围，已有检查点保留',422);
      streamed+=delta;
      cp.partial={key,text:prefix+streamed,truncated:true,interrupted:true,outputBudget:budget};
    };
    let abort;
    const aborted=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try {
      const result=await Promise.race([ctx.directChat(model,message,history,{systemHint,timeout:300000,idleTimeout:90000,stream:true,signal,thinking:false,maxTokens:budget,allowPartial:true,throwOnError:true,
        onDelta,onProgress:progress=>{signal.throwIfAborted();run.progress={...progress};fact.progress={...progress};saveProgress();}}),aborted]);
      signal.throwIfAborted();
      if(result?.timeout)throw designError('模型响应超时，已有内容和检查点保留',504);
      if(!result)throw designError('模型没有返回正文，已有内容保留',502);
      lastModel=result.usedModel||model;
      Object.assign(fact,{usedModel:lastModel,finishReason:result.finishReason||null,truncated:!!result.truncated,outputBudget:result.outputBudget||budget,characters:String(result.text||'').length});
      run.actualModel=`${lastModel.provider}/${lastModel.id}`;
      run.lastSuccessfulModel=run.actualModel;
      return result;
    } catch(error) {fact.failed=true;fact.errorCode=error.code||error.name;throw error;}
    finally {fact.finishedAt=new Date().toISOString();signal.removeEventListener('abort',abort);if(streamed)saveProgress(true);}
  }
  async function unit(key,message,systemHint,validate,stage,label) {
    let budget=clampOutputTokens(model,{fallback:16384}),result,text='',recovered=false;
    const old=cp.partial?.key===key?cp.partial:null;
    if(old?.truncated&&old.text){text=old.text;budget=old.outputBudget||budget;result={truncated:true};}
    else {event(stage,label);result=await call(message,[],systemHint,budget,key);text=String(result.text||'');}
    const checkpoint=()=>{
      if(text.length>700000)throw designError('单个区块超出 70 万字符安全范围；此前检查点保留，请重新设计这一页',422);
      cp.partial={key,text,truncated:!!result.truncated,outputBudget:result.outputBudget||budget};
    };
    checkpoint();
    if(result.truncated) {
      event('recovering','输出触及单次长度限制，片段已保存，正在继续这一部分');
      budget=escalateOutputTokens(result.outputBudget||budget,model,{hardCap:65536});
      const history=[{role:'user',content:message},...(text?[{role:'assistant',content:text}]:[])];
      result=await call(text?'接着上一条 JSON 的断点继续，只输出剩余字符，不重复已有内容，不加代码围栏。':'上一条没有输出正文。请直接返回所需 JSON。',history,systemHint,budget,key,text);
      text+=String(result.text||'');recovered=true;checkpoint();
      if(result.truncated){event('checkpoint','仍触及长度限制，已保留片段，可继续本次任务');throw designError('这一部分仍未写完，已保存检查点；可继续本次任务',422);}
    }
    event('validating',recovered?'正在校验续写拼接结果':'已收到内容，正在检查结构与修改范围');
    try {const value=validate(parseDesignReply(text));cp.partial=null;return value;}
    catch(error) {
      event('repairing','内容未通过校验，正在请求同一模型修正一次');
      result=await call(message+'\n校验错误：'+error.message+'\n请修正并返回完整 JSON。上次正文：'+text.slice(0,100000),[],systemHint,budget,key);
      text=String(result.text||'');checkpoint();
      if(result.truncated){event('checkpoint','修正结果未写完，已保留片段');throw designError('修正结果触及长度限制，已保存检查点；可继续本次任务',422);}
      const value=validate(parseDesignReply(text));cp.partial=null;return value;
    }
  }
  const info={title:project.title,brief:project.brief,references:project.references,instruction:request.instruction};
  let doc;
  if(request.mode==='creative'&&!request.targetId) {
    const planHint=websiteRules+'先做设计计划，不输出整页。返回 {"direction":"视觉叙事、排版与配色方向","css":"全局基础样式与设计变量","sections":[{"title":"区块名称","brief":"区块内容与构图"}]}。按需求安排 1–8 个区块，导航与页脚也纳入计划；这只是单页执行安全范围，不是固定模板。参考模板仅作可选灵感，可完全重构。';
    cp.plan ||= await unit('plan','本作品资料：'+JSON.stringify({...info,optionalReference:request.reference||null}),planHint,validatePlan,'planning','正在根据想法规划页面内容与视觉方向');
    event('planned',`设计方向已确定，将分 ${cp.plan.sections.length} 个区块生成`);
    for(let i=cp.sections.length;i<cp.plan.sections.length;i++) {
      overall.throwIfAborted();
      const spec=cp.plan.sections[i],section=await unit(`section-${i+1}`,JSON.stringify({...info,plan:cp.plan,section:spec,index:i+1}),
        websiteRules+`返回 {"html":"本区块 HTML","css":"本区块样式"}。只生成第 ${i+1} 个区块，唯一根元素 id="site-section-${i+1}"；子元素 id 加 s${i+1}- 前缀。不要生成其他区块或重复导航/页脚。样式只作用于本区块；使用平铺 CSS，不使用嵌套选择器；遵循计划的全局变量，具体样式在此返回。`,
        value=>validateSection(value,i+1,cp.plan,cp.sections),'section',`正在生成 ${i+1}/${cp.plan.sections.length}：${spec.title}`);
      cp.sections.push(section);event('checkpoint',`已保存 ${i+1}/${cp.plan.sections.length} 个区块`);
    }
    doc=assembleSections(cp.plan,cp.sections);
  } else {
    const target=request.targetId;
    const systemHint=websiteRules+(target?'返回 {"html":"选中元素完整HTML"}，只修改给出的选区，必须保留根元素 id；样式仅用 inline style，不返回 CSS，不修改祖先或兄弟元素。':'返回 {"html":"body 内完整内容","css":"完整样式"}。保留已有内容和设计方向，按要求优化，不随意退回通用模板。');
    doc=await unit('page','本作品资料：'+JSON.stringify({...info,...(target?{targetId:target,selectedHtml:fragment}:{current:base.doc})}),systemHint,
      value=>target?patchWebsite(base.doc,target,value):validateWebsite(value),'generating','请求已发送，等待模型返回设计内容');
  }
  overall.throwIfAborted();
  return {doc,usedModel:lastModel};
}
