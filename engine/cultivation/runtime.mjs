import {createCultivationStorage} from './storage.mjs';
import {createIdentityAuthority} from './identity.mjs';
import {createCultivationControls} from './controls.mjs';
import {createCultivationProjection} from './projection.mjs';
import {createCultivationTasks} from './tasks.mjs';
import {createHumanGrants} from './human-grants.mjs';
import {createOwnerGrants} from './owner-grants.mjs';
import {createSessionGrants} from './session-grants.mjs';
import {commandKinds} from './control-transition.mjs';
import {exact,id} from './control-state.mjs';
import {validatePolicy} from './policy.mjs';
import {createLearningCommands,validateLearningCommand} from './learning.mjs';
import {createCultivationMedia,validateMediaCommand} from './media.mjs';
import {learningAllowed} from './learning-permissions.mjs';
import {createRecoveryCommands,validateRecoveryCommand} from './recovery.mjs';

// Construction never dispatches. The host explicitly starts the bounded
// executor; policy, shared resources and genuine identities gate every write.
export function createCultivationRuntime({wsRoot, identityAdapters, humanConfig, ownerProvider, sessionApproval, execution, learning, learningJob, verifyAsset, now = Date.now}) {
  const store = createCultivationStorage({wsRoot});
  const owner=!humanConfig&&ownerProvider?createOwnerGrants({workspace:store.workspace,provider:ownerProvider(store.workspace),now}):null;
  const grants=humanConfig?createHumanGrants({workspace:store.workspace,now,...humanConfig}):owner;
  const sessionGrants=createSessionGrants({workspace:store.workspace,now,host:sessionApproval});
  const resolveHuman=typeof identityAdapters?.resolveHuman==='function'||grants||sessionGrants.available
    ? (source,context)=>identityAdapters?.resolveHuman?.(source,context) ??
      grants?.resolveHuman?.(source,context) ?? sessionGrants.resolveHuman(source,context)
    : undefined;
  const adapters={...identityAdapters,resolveHuman};
  const authority = createIdentityAuthority({workspace: store.workspace, now, ...adapters});
  const media=createCultivationMedia({wsRoot,store,authority,getControls:()=>controls,now});
  verifyAsset??=media.verify;
  const controls = createCultivationControls({store, authority, verifyAsset, now});
  const projection = createCultivationProjection({store});
  const writeIdentityAvailable = () => !!grants?.available ||
    typeof identityAdapters?.resolveHuman==='function';
  const tasks=execution?createCultivationTasks({...execution,wsRoot,store,controls,authority,verifyAsset,now}):null;
  const learn=createLearningCommands({authority,controls,learning,getJob:learningJob,now});
  const recover=createRecoveryCommands({authority,controls,admission:execution?.admission});
  return Object.freeze({
    get writeIdentityAvailable(){return writeIdentityAvailable();},
    get sessionGrantAvailable(){return sessionGrants.available;},
    async readMother(command,source,{signal}={}){
      signal?.throwIfAborted();
      const principal=authority.issue('mother',source,command);authority.assert(principal,command,['mother']);
      if(command.action==='learning.context'){
        if(!exact(command,['action','payload'])||!exact(command.payload,['query'])||
          typeof command.payload.query!=='string'||command.payload.query.length>1000)throw new Error('cultivation_invalid_command');
        if(!learning)throw new Error('cultivation_executor_unavailable');
        const current=()=>{
          const actor=authority.assert(principal,command,['mother']),state=controls.read();
          if(!state.data.policy.enabled||Date.parse(state.data.policy.expiresAt)<=now())throw new Error('cultivation_policy_disabled');
          return {revision:state.revision,motherActorId:actor.actorId,motherLearning:state.data.policy.motherLearning===true,
            agentIds:state.data.agents.filter(a=>a.mentorId===actor.actorId&&a.status==='ready'&&
            learningAllowed(state.data.policy,state.data.designs.find(d=>d.id===a.designId)?.design)).map(a=>a.id)};
        };
        const before=current(),result=await learning.context({scope:'mother',agentIds:before.agentIds,
          motherActorId:before.motherActorId,motherLearning:before.motherLearning,controlRevision:before.revision,
          query:command.payload.query,maxTokens:1200,requireRelevant:true,signal});
        signal?.throwIfAborted();
        if(JSON.stringify(before)!==JSON.stringify(current()))throw new Error('cultivation_policy_changed');
        return {available:result.available!==false,context:result.context,entries:result.entries.map(e=>({id:e.id,jobId:e.jobId}))};
      }
      return command.action==='overview'?this.overview():this.list(command.action,{limit:20});
    },
    async overview(){return {...projection.overview(),writeIdentityAvailable:writeIdentityAvailable(),sessionGrantAvailable:sessionGrants.available,
      motherIdentityAvailable:typeof adapters.resolveMother==='function',
      executorAvailable:!!tasks,humanGrantAvailable:!!grants?.available,
      ownerConfirmation:{mode:humanConfig?'external-signature':owner?'windows-hello':'unavailable',state:owner?.state??(grants?.available?'paired':'unavailable'),workspace:store.workspace},
      usage:execution?await execution.budget.status():null,admission:execution?await execution.admission.status():null,
      taskStatus:tasks?.status()??null};},
    list:(collection,query)=>collection==='runs'&&tasks?{...tasks.list(query),supported:true}:
      collection==='experience'&&tasks?tasks.listExperience(query):projection.list(collection,query),
    detail:agentId=>{const detail=projection.detail(agentId);return detail?{...detail,
      agent:{...detail.agent,cancellation:detail.agent.cancellation==='not_requested'?'not_requested':tasks?.cancellation(agentId)??detail.agent.cancellation},executorAvailable:!!tasks}:null;},
    media:media.get,
    challenge(command){if(!grants?.available)throw new Error('cultivation_identity_unavailable');
      if(!['policy.set','agent.pause','agent.resume','agent.archive','agent.rollback','run.cancel','learning.decide','asset.revoke','resources.reconcile'].includes(command.action))
        throw new Error('cultivation_identity_denied');
      if(command.action==='run.cancel'){
        if(!exact(command,['action','requestId','expectedRevision','payload'])||!id(command.requestId)||
          !Number.isSafeInteger(command.expectedRevision)||command.expectedRevision<0||
          !exact(command.payload,['runId'])||!id(command.payload.runId))throw new Error('cultivation_invalid_command');
      }else if(command.action==='resources.reconcile')validateRecoveryCommand(command);
      else if(command.action==='asset.revoke')validateMediaCommand(command);
      else if(command.action==='learning.decide')validateLearningCommand(command);else commandKinds(command);
      if(command.action==='policy.set')validatePolicy(command.payload.policy);
      return grants.challenge(command);},
    sessionChallenge(command,sessionId){
      if(command?.action!=='policy.set')throw new Error('cultivation_identity_denied');
      commandKinds(command);validatePolicy(command.payload.policy);
      return sessionGrants.challenge(command,sessionId);
    },
    sessionConfirm(idValue,command,sessionId){
      if(command?.action!=='policy.set')throw new Error('cultivation_identity_denied');
      commandKinds(command);validatePolicy(command.payload.policy);
      return sessionGrants.confirm(idValue,command,sessionId);
    },
    verifySession:(proof,command,sessionId)=>({kind:'human',source:sessionGrants.verify(proof,command,sessionId)}),
    verifyHuman:(proof,command)=>{if(!grants?.available)throw new Error('cultivation_identity_unavailable');
      return {kind:'human',source:grants.verify(proof,command)};},
    execute: async (command, kind, trustedSource) => {
      const principal=authority.issue(kind,trustedSource,command);
      if(command.action==='resources.reconcile')return recover(command,principal);
      if(command.action?.startsWith('asset.'))return media.execute(command,principal);
      if(command.action==='learning.decide')return learn(command,principal);
      if(command.action?.startsWith('run.')){
        if(!tasks)throw new Error('cultivation_executor_unavailable');return tasks.execute(command,principal);
      }
      const result=await controls.execute(command,principal);
      if(kind==='human')tasks?.interrupt();return result;
    },
    tick:()=>tasks?.tick(),
    async start(){await controls.reconcile();await tasks?.recover();tasks?.start();},
    async close(){grants?.revoke();sessionGrants.revoke();await tasks?.close();},
  });
}
