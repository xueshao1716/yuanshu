// 2026-10-07 真机：前台聊天不再挡培养（admission 不让前台）；这里的 foregroundBusy 只由宿主接语音等真正独占的前台。
// Never race abort against the provider promise: a slot remains held until the
// underlying operation finishes. Unknown usage stays reserved across restart.
export function createTaskDispatch({repo,assertRun,ownerId,active,admission,budget,knowledge,provider,
  foregroundBusy=()=>false,onRunFinished=null,now=Date.now}) {
  // 独立验证：另起一次隔离调用，只看任务/验收标准/输出，不看设计稿与执行过程。
  // 验证失败或额度不够只记「未验证」，不影响已完成的任务，也绝不当作通过。
  const verifyOutput=async(run,design,policy,sharedPolicy,output)=>{
    const record=verification=>{const r=repo.get(run.id);if(r)repo.update(run.id,{cultivation:{...r.cultivation,verification:{...verification,at:now()}}});};
    let reservation,controller,deadline;
    try{
      if(typeof provider.verifyPrepare!=='function')return void record({verdict:'unverified',reason:'verifier_unavailable'});
      const plan=await provider.verifyPrepare({run,design,policy,sharedPolicy,output});
      reservation=await budget.reserve({kind:'model',policy:sharedPolicy,maxCost:plan.maxCost,
        currency:plan.currency,free:plan.free===true,consumer:'cultivation',limits:policy});
      controller=new AbortController();active.set(run.id,controller);
      deadline=setTimeout(()=>controller.abort(),policy.timeoutMs??60000);
      let result;
      try{result=await provider.verifyInvoke({plan,output,signal:controller.signal,guard:()=>{assertRun(run);}});}
      catch(error){try{await budget.settle(reservation.id,null);}catch{}reservation=null;throw error;}
      await budget.settle(reservation.id,result.usage??null);reservation=null;
      record(result.verification);
    }catch(error){
      if(reservation)try{await budget.settle(reservation.id,null);}catch{}
      try{record({verdict:'unverified',reason:/^cultivation_[a-z_]+$/.test(error?.message)?error.message:'verifier_unavailable'});}catch{}
    }finally{clearTimeout(deadline);active.delete(run.id);}
  };
  return async()=>{
    if(foregroundBusy())return;
    let run,slot,reservation,controller,watchdog,deadline,invoked=false;
    const patch=(status,changes)=>{const r=repo.get(run.id);const next=repo.update(run.id,{status,cultivation:{...r.cultivation,...changes}});
      // 终态主动告诉主人（用户主动取消不打扰）；通知失败绝不影响培养本身。
      if(onRunFinished&&["completed","failed","stopped","interrupted"].includes(status)&&changes?.reason!=="cancelled")try{onRunFinished(next)}catch{}
      return next;};
    try{
      slot=await admission.acquire('cultivation',{yieldForeground:false});if(!slot)return;
      await repo.transaction(async()=>{
        for await(const row of repo.scan())if(row.status==='queued'){run=row;break;}
        if(!run)return;
        // Claim is durable before reserving money or calling a provider.
        run=repo.update(run.id,{status:'running',ownerId});
      });
      if(!run)return;
      const {policy,design}=assertRun(run),sharedPolicy=await knowledge.policy();
      const plan=await provider.prepare({run,design,policy,sharedPolicy});
      // 拒绝原因分开报：真机上笼统的 request_denied 让人查了两天授权，实际是单价×额度算出的最坏费用超过设计单次上限。
      if(plan.remote!==design.permissions.remote||plan.remote&&!policy.allowRemote)throw new Error('cultivation_remote_mismatch');
      if(!Number.isFinite(plan.maxCost)||plan.maxCost<0)throw new Error('cultivation_price_invalid');
      if(Math.ceil(plan.maxCost*100)>design.permissions.costUpperBoundCents)throw new Error('cultivation_cost_cap_exceeded');
      assertRun(run);if(foregroundBusy())throw new Error('cultivation_foreground_busy');
      if(repo.get(run.id).status!=='running')throw new Error('cultivation_cancel_requested');
      reservation=await budget.reserve({kind:'model',policy:sharedPolicy,maxCost:plan.maxCost,
        currency:plan.currency,free:plan.free===true,consumer:'cultivation',limits:policy});
      patch(repo.get(run.id).status,{reservationId:reservation.id});assertRun(run);
      if(repo.get(run.id).status!=='running'||foregroundBusy())throw new Error('cultivation_cancel_requested');
      controller=new AbortController();active.set(run.id,controller);
      watchdog=setInterval(()=>{try{assertRun(run);if(foregroundBusy())controller.abort();}catch{controller.abort();}},1000);
      deadline=setTimeout(()=>controller.abort(),policy.timeoutMs??60000);
      invoked=true;
      const result=await provider.invoke({run,design,policy,plan,signal:controller.signal,guard:()=>{
        assertRun(run);if(foregroundBusy()||repo.get(run.id).status!=='running')throw new Error('cultivation_cancel_requested');
        if(!knowledge.policyCurrent(sharedPolicy.revision))throw new Error('cultivation_shared_policy_changed');
      }});
      await budget.settle(reservation.id,result?.usage??null);
      if(controller.signal.aborted||repo.get(run.id).status==='stopping')return void patch('stopped',{reason:'cancelled',output:null,usage:result?.usage??null});
      assertRun(run);
      if(typeof result?.text!=='string'||!result.text.trim()||result.text.length>16000)throw new Error('cultivation_provider_format');
      patch('completed',{output:result.text,usage:result.usage??null,reason:null,completedAt:now(),verification:null});
      await verifyOutput(run,design,policy,sharedPolicy,result.text);
    }catch(error){
      // 2026-10-07：模型明确答复了（如输出被截断）就不是「结果未知」——按实际用量结算，记为失败并给出原因。
      const known=invoked&&error?.definite===true&&!controller?.signal.aborted&&error.usage;
      if(reservation)try{await budget.settle(reservation.id,known?error.usage:invoked?null:{cost:0,currency:reservation.currency});}
      catch{
        // Persist an unknown outcome, not a phantom running task or a replay.
        // The reservation stays held for explicit accounting reconciliation.
        if(run)patch('interrupted',{reason:'settlement_pending',output:null});
        return;
      }
      if(run&&known&&repo.get(run.id).status==='running')return void patch('failed',{reason:error.message,output:null,usage:error.usage});
      if(run){const interrupted=controller?.signal.aborted||repo.get(run.id).status==='stopping';
        const waiting=!invoked&&!interrupted&&['cultivation_outside_window','cultivation_foreground_busy'].includes(error.message);
        patch(waiting?'queued':invoked?'interrupted':'stopped',{reason:invoked?'outcome_unknown':interrupted?'cancelled':
          /^cultivation_[a-z_]+$/.test(error.message)?error.message:'resource_or_provider_unavailable',output:null});}
    }finally{
      clearInterval(watchdog);clearTimeout(deadline);if(run)active.delete(run.id);
      if(slot)await admission.release(slot.id);
    }
  };
}
