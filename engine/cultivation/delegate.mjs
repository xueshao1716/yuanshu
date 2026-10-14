import {randomUUID} from 'node:crypto';

// delegate_task({agent_id}) 的培养出口：把一个文本任务交给自己培养的个体。
// 走的是和 run.submit 同一条排队通道（策略、预算、单次费用上限、独立验证员全都照旧），
// 只是在这一轮里等结果，个体的派发权限标记不动；经验由执行器按「验证通过才入待核验经验」自动登记，
// 是否采用仍须母体用 learning.decide 决定。
const TERMINAL=new Set(['completed','failed','stopped','interrupted']);
const DEFAULT_CRITERION='直接完成任务；结论可核对，没有依据的内容明说「不确定」，不编造事实、数据或来源。';
const VERDICT={pass:'通过',partial:'部分满足',fail:'不满足',unverified:'未验证'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const err=text=>({text,isError:true});

export async function delegateToCultivatedAgent(runtime,args,host,{waitMs=170000,pollMs=1000}={}){
  const task=String(args?.task??'').trim();
  if(!task)return err('delegate_task 需要 task');
  if(!host?.executionIdentity||!runtime)return err('培养个体只在主人亲自发起的对话里可以调用（这一轮没有母体执行身份）。');
  const agentId=String(args.agent_id).trim();
  let agents,designs;
  try{
    agents=runtime.list('agents',{limit:50});
    designs=runtime.list('designs',{limit:50});
  }catch(error){return err(/^cultivation_[a-z_]+$/.test(error?.message)?error.message:'cultivation_unavailable');}
  const name=agent=>designs.items.find(d=>d.id===agent.designId)?.design?.name??agent.id;
  const ready=agents.items.filter(a=>a.status==='ready');
  const agent=ready.find(a=>a.id===agentId);
  if(!agent)return err(`没有可用的个体 ${agentId}。当前可调用：${ready.map(a=>`${name(a)}（${a.id}）`).join('；')||'无'}。`);
  const context=Array.isArray(args.context)?args.context.filter(c=>typeof c==='string'&&c.trim()):[];
  const input=[task,...(context.length?['背景：',...context]:[])].join('\n');
  const criterion=String(args.criterion??'').trim()||DEFAULT_CRITERION;
  if(input.length>4000||criterion.length>4000)return err('培养个体的任务输入最多 4000 字（含 context），请精炼后重试；不会静默截断。');
  let runId;
  try{
    const submitted=await runtime.execute({action:'run.submit',requestId:randomUUID(),expectedRevision:agents.revision,
      payload:{agentId:agent.id,input,goal:task.slice(0,4000),criterion}},'mother',host.executionIdentity);
    runId=submitted.result.id;
  }catch(error){return err(/^cultivation_[a-z_]+$/.test(error?.message)?error.message:'cultivation_unavailable');}
  const deadline=Date.now()+waitMs;
  let run;
  while(Date.now()<deadline){
    if(host.signal?.aborted)return {...err(`已取消等待；作业 ${runId} 仍在培养队列，可在培养页查看。`),cancelled:true};
    void runtime.tick()?.catch?.(()=>{});
    run=runtime.runView(runId);
    // completed 之后验证员还要再跑一次，verification 为 null 表示尚在验证。
    if(run&&TERMINAL.has(run.status)&&(run.status!=='completed'||run.verification))break;
    await sleep(pollMs);
  }
  run=runtime.runView(runId)??run;
  const label=`${name(agent)}（${agent.id}）`;
  if(!run||!TERMINAL.has(run.status))return {text:`已把任务交给 ${label}，但这一轮等不到结果（作业 ${runId} 仍在培养队列）。下一轮用 cultivation 读 runs 取结论，不要重复提交。`,isError:false,agentRunId:runId};
  if(run.status!=='completed')return {...err(`${label} 没有完成：${run.reason||run.status}。${run.status==='interrupted'?'实际结果未知，不要当成成功或失败。':''}`),agentRunId:runId};
  const v=run.verification;
  const verdict=v?VERDICT[v.verdict]??v.verdict:'验证中';
  const gaps=v?.gaps?.length?`\n未核实：${v.gaps.join('；')}`:'';
  return {text:`【培养个体 ${label} 的结论】${run.output}\n独立验证：${verdict}${gaps}\n`+
    (v?.verdict==='pass'?'验证通过的输出会自动登记为待核验经验；是否采用由母体 learning.decide 决定。':'验证未通过，不会登记为经验；使用前请自行核对。'),
    isError:false,agentRunId:runId,verdict:v?.verdict??'pending'};
}
