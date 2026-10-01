// Never race abort against the provider promise: a slot remains held until the
// underlying operation finishes. Unknown usage stays reserved across restart.
export function createTaskDispatch({repo,assertRun,ownerId,active,admission,budget,knowledge,provider,
  foregroundBusy=()=>false,now=Date.now}) {
  return async()=>{
    if(foregroundBusy())return;
    let run,slot,reservation,controller,watchdog,deadline,invoked=false;
    const patch=(status,changes)=>{const r=repo.get(run.id);return repo.update(run.id,{status,cultivation:{...r.cultivation,...changes}});};
    try{
      slot=await admission.acquire('cultivation');if(!slot)return;
      await repo.transaction(async()=>{
        for await(const row of repo.scan())if(row.status==='queued'){run=row;break;}
        if(!run)return;
        // Claim is durable before reserving money or calling a provider.
        run=repo.update(run.id,{status:'running',ownerId});
      });
      if(!run)return;
      const {policy,design}=assertRun(run),sharedPolicy=await knowledge.policy();
      const plan=await provider.prepare({run,design,policy,sharedPolicy});
      if(plan.remote!==design.permissions.remote||plan.remote&&!policy.allowRemote||
        !Number.isFinite(plan.maxCost)||plan.maxCost<0||Math.ceil(plan.maxCost*100)>design.permissions.costUpperBoundCents)
        throw new Error('cultivation_request_denied');
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
      patch('completed',{output:result.text,usage:result.usage??null,reason:null,completedAt:now()});
    }catch(error){
      if(reservation)try{await budget.settle(reservation.id,invoked?null:{cost:0,currency:reservation.currency});}
      catch{
        // Persist an unknown outcome, not a phantom running task or a replay.
        // The reservation stays held for explicit accounting reconciliation.
        if(run)patch('interrupted',{reason:'settlement_pending',output:null});
        return;
      }
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
