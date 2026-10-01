import {randomUUID} from 'node:crypto';
import {clonePayload} from './state.mjs';
import {exact,id} from './control-state.mjs';
import {assertAdoptable} from './designs.mjs';
import {assertDispatchWindow} from './policy.mjs';
import {createCultivationTaskRepository} from './task-repository.mjs';
import {createTaskDispatch} from './task-dispatch.mjs';
import {createCultivationExperience} from './experience.mjs';
import {LEARNING_SCOPE} from './learning-permissions.mjs';

const fail=code=>{throw new Error(`cultivation_${code}`);};
export function createCultivationTasks(options) {
  const {wsRoot,store,controls,authority,now=Date.now,verifyAsset}=options;
  const repo=createCultivationTaskRepository({wsRoot,workspace:store.workspace,now});
  const ownerId=randomUUID(),active=new Map();let timer=null,pending=null,closed=false,lastError=null;
  const assertRun=run=>{
    const state=controls.read(),a=state.data.agents.find(a=>a.id===run.cultivation.agentId);
    if(!a||a.status!=='ready')fail('agent_paused');
    if(state.revision!==run.cultivation.policyRevision||a.designId!==run.cultivation.designId)fail('policy_changed');
    const design=state.data.designs.find(d=>d.id===a.designId)?.design;
    assertAdoptable(design,state.data.policy,{now:now(),agentId:a.id,verifyAsset});
    assertDispatchWindow(state.data.policy,now());
    const child=store.read(a.id),intent=state.data.intents.find(i=>i.agentId===a.id);
    if(!intent||!child.revision||child.data.initializationId!==intent.id)fail('initialization_conflict');
    if(design.permissions.tools.length||design.permissions.dataScopes.some(scope=>scope!==LEARNING_SCOPE))fail('unsupported_permissions');
    return {policy:state.data.policy,design};
  };
  const dispatch=createTaskDispatch({...options,repo,assertRun,ownerId,active,now});
  const experience=createCultivationExperience({repo,knowledge:options.knowledge,workspace:store.workspace});
  const execute=async(input,principal)=>{
    const c=clonePayload(input),cancel=c.action==='run.cancel';
    if(!exact(c,['action','payload','requestId','expectedRevision'])||!id(c.requestId)||
      !Number.isSafeInteger(c.expectedRevision)||c.expectedRevision<0||
      !['run.submit','run.cancel'].includes(c.action)||!exact(c.payload,cancel?['runId']:['agentId','input','goal','criterion']))fail('invalid_command');
    if(!id(cancel?c.payload.runId:c.payload.agentId)||!cancel&&['input','goal','criterion'].some(k=>
      typeof c.payload[k]!=='string'||!c.payload[k].trim()||c.payload[k].length>4000))fail('invalid_command');
    const authenticate=()=>authority.assert(principal,c,[cancel?'human':'mother']);
    return repo.transaction(()=>{
      const actor=authenticate(),state=controls.read();
      const prior=repo.list().find(r=>cancel?r.cultivation.cancel?.id===c.requestId:r.clientRequestId===c.requestId);
      if(prior){const receipt=cancel?prior.cultivation.cancel:prior.cultivation;
        if(receipt.actor.actorId!==actor.actorId||receipt.actor.originId!==actor.originId||receipt.actor.commandHash!==actor.commandHash)fail('idempotency_conflict');
        return {result:{id:prior.id},revision:state.revision};}
      if(state.revision!==c.expectedRevision)fail('revision_conflict');
      if(cancel){
        const r=repo.get(c.payload.runId);if(!r)fail('run_not_found');
        if(!['queued','running','stopping'].includes(r.status))fail('invalid_transition');
        const status=r.status==='queued'?'stopped':'stopping';
        repo.update(r.id,{status,cultivation:{...r.cultivation,cancel:{id:c.requestId,actor},reason:'cancel_requested'}});
        active.get(r.id)?.abort();return {result:{id:r.id},revision:state.revision};
      }
      const agent=state.data.agents.find(a=>a.id===c.payload.agentId);
      if(!agent||agent.mentorId!==actor.actorId)fail('identity_denied');
      const cultivation={workspace:store.workspace,agentId:agent.id,designId:agent.designId,policyRevision:state.revision,
        actor,goal:c.payload.goal,criterion:c.payload.criterion,output:null,usage:null,reservationId:null,reason:null};
      // Submission may wait outside a dispatch window, but it cannot widen permissions.
      const design=state.data.designs.find(d=>d.id===agent.designId).design;
      assertAdoptable(design,state.data.policy,{now:now(),agentId:agent.id,verifyAsset});
      if(agent.status!=='ready')fail('agent_paused');
      const run=repo.create({sessionId:`cultivation:${agent.id}`,clientRequestId:c.requestId,
        origin:'cultivation',motherIdentityEligible:false,ownerId,message:c.payload.input,model:design.permissions.model,cultivation});
      return {result:{id:run.id},revision:state.revision};
    });
  };
  const tick=()=>{
    if(closed||pending)return pending??Promise.resolve();
    pending=dispatch().then(()=>experience.reconcile()).then(()=>{lastError=null;}).catch(error=>{lastError='task_storage_unavailable';throw error;})
      .finally(()=>{pending=null;});return pending;
  };
  return Object.freeze({execute,tick,get:repo.get,listExperience:experience.list,
    cancellation(agentId){
      const runs=repo.list().filter(r=>r.cultivation.agentId===agentId);
      if(runs.some(r=>r.status==='interrupted'&&['outcome_unknown','settlement_pending'].includes(r.cultivation.reason)))return 'outcome_unknown';
      if(runs.some(r=>['queued','running','stopping'].includes(r.status)))return 'pending_confirmation';
      return 'confirmed';
    },
    list:repo.page,
    status:()=>({started:!!timer,active:active.size,lastError}),
    async recover(){return repo.transaction(()=>{
      for(const r of repo.list())if(['running','stopping'].includes(r.status)&&r.ownerId!==ownerId)
        repo.update(r.id,{status:'interrupted',cultivation:{...r.cultivation,reason:'outcome_unknown'}});
    });},
    interrupt(){for(const controller of active.values())controller.abort();},
    start(){if(timer||closed)return;timer=setInterval(()=>{void tick().catch(()=>{});},5000);timer.unref?.();},
    async close(){
      closed=true;clearInterval(timer);timer=null;for(const controller of active.values())controller.abort();
      if(!pending)return;
      let timeout;try{
        await Promise.race([pending,new Promise(resolve=>{timeout=setTimeout(resolve,options.shutdownMs??2000);})]);
      }finally{clearTimeout(timeout);}
      // No release or replay: a transport that ignores abort may still be live.
      for(const runId of active.keys()){
        const run=repo.get(runId);repo.update(runId,{status:'interrupted',cultivation:{...run.cultivation,reason:'outcome_unknown',output:null}});
      }
    },
  });
}
