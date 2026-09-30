import {randomUUID} from 'node:crypto';
import {digest,guardFor,fail} from './knowledge-state.mjs';
const safeReason=e=>/^[a-z][a-z0-9_]{0,70}$/.test(e?.code||'')?e.code:'knowledge_step_failed';
export function createKnowledgeWorker({store,collect,extract,validate,foregroundBusy=()=>false,now=Date.now,random=Math.random,onSettled=()=>{},reconcile=()=>{}}){
  const owner=randomUUID();let running=false,controller=null,timer=null,wakeTimer=null,stopped=false,failures=0,cooldownUntil=0,lastError=null,startAfter=0,inflight=null;
  const execute=async()=>{
    if(stopped||running||now()<startAfter)return {state:'idle'};
    if(foregroundBusy())return {state:'foreground_busy'};
    running=true;let job;
    try{
      const persisted=await store.workerState();failures=persisted.failures;cooldownUntil=persisted.cooldownUntil;
      if(cooldownUntil>now())return {state:'cooldown',until:cooldownUntil};
      controller=new AbortController();const signal=controller.signal;
      if(stopped)controller.abort();
      await reconcile({signal,foregroundBusy});signal.throwIfAborted();if(foregroundBusy())fail('foreground_busy');
      job=await store.claim(owner);if(!job)return {state:'idle'};
      const check=async({yieldForeground=true}={})=>{
        signal.throwIfAborted();if(yieldForeground&&foregroundBusy())fail('foreground_busy');
        const policy=await store.policy(),current=await store.get(job.id);
        if(policy.revision!==job.policyRevision||policy.paused||!policy.localEnabled)fail('policy_changed');
        if(current.revision!==job.revision||current.generation!==job.generation)fail('stale_claim');
        if(job.approval&&job.relatedJobId&&(await store.get(job.relatedJobId))?.revision!==job.approval.parentRevision)fail('review_parent_changed');
        return policy;
      };
      const step=async patch=>{job=await store.transition(job.id,guardFor(job),patch);};
      const policy=await check();
      const snapshots=await collect({job,policy,signal});
      const version=digest(snapshots.map(s=>[s.locator,s.hash]));
      if(job.state==='collecting'&&job.sources.length&&job.sources.every(s=>s.kind==='url'&&!s.hash))job=await store.bindSources(job.id,guardFor(job),snapshots);
      if(version!==job.sourceVersion)fail('source_changed');
      if(job.state==='collecting')await step({state:'extracting'});
      let candidate=job.candidate;
      if(job.state==='extracting'){
        await check();candidate=await extract(snapshots,job,{policy,signal});
        // Completed paid output survives a foreground yield, but never a revoked claim.
        await check({yieldForeground:false});await step({state:'validating',candidate});
      }
      if(job.state==='validating'){
        await check();const validation=await validate({candidate,snapshots,job,entries:await store.entries(),now:now()});
        await step({state:validation.state,reason:validation.reason,validation});
      }
      if(job.state==='ready'){
        const policy=await check();
        // Re-read source immediately before commit; never trust a pre-model snapshot alone.
        const current=await collect({job,policy,signal,revalidate:true});
        if(digest(current.map(s=>[s.locator,s.hash]))!==job.sourceVersion)fail('source_changed');
        const validation=await validate({candidate,snapshots:current,job,entries:await store.entries(),now:now()});
        await check();
        if(validation.state!=='ready')await step({state:validation.state,reason:validation.reason,validation});
        else job=await store.commit(job.id,guardFor(job),validation.entry);
      }
      failures=0;cooldownUntil=0;await store.saveWorkerState({failures,cooldownUntil});
      lastError=null;await onSettled(job);return {state:job.state,id:job.id};
    }catch(error){
      const reason=safeReason(error);lastError=reason;
      if(job){
        const current=await store.get(job.id).catch(()=>null);
        if(current?.revision===job.revision){
          const transient=reason==='provider_transient',attempts=job.attempts+(transient?1:0);
          if(transient&&++failures>=3)cooldownUntil=now()+30*60000;
          if(transient)await store.saveWorkerState({failures,cooldownUntil});
          const retry=reason==='foreground_busy'||error.name==='AbortError'||transient&&attempts<3;
          const patch={state:retry?'retry_wait':transient?'failed':'blocked',reason,attempts,
            nextAttemptAt:now()+(reason==='foreground_busy'?1000:attempts<2?60000:300000)+Math.floor(random()*10000)};
          try{job=await store.transition(job.id,guardFor(job),patch);}catch(e){if(!['policy_changed','stale_claim'].includes(e.code))throw e;}
        }
      }
      return {state:'deferred',reason};
    }finally{running=false;controller=null;}
  };
  const tick=()=>{if(running)return Promise.resolve({state:'idle'});inflight=execute();return inflight;};
  const safely=()=>tick().catch(()=>{lastError='knowledge_unavailable';});
  return {tick,
    interrupt(){controller?.abort();},
    status:()=>({running,cooldownUntil,lastError}),
    wake(){if(stopped||wakeTimer)return;wakeTimer=setTimeout(()=>{wakeTimer=null;void safely();},1000);wakeTimer.unref();},
    start({startupMs=120000,intervalMs=60000}={}){
      stopped=false;if(timer)return;startAfter=now()+startupMs;timer=setTimeout(()=>{void safely();timer=setInterval(()=>void safely(),intervalMs);timer.unref();},startupMs);timer.unref();
    },
    async stop(){stopped=true;clearTimeout(timer);clearInterval(timer);clearTimeout(wakeTimer);timer=null;wakeTimer=null;controller?.abort();await inflight;},
  };
}
