// Synthetic evidence only. No real identity, workspace, source or credentials.
import {enabledPolicy} from './cultivation-fixture.mjs';

export const observedAt=1790852400000;
export function experience(id,{resolved=false,invalid=false,design=true}={}){
  const agentId=`agent-${id}-${'a'.repeat(64)}`,knowledgeJobId=`job-${id}-${'b'.repeat(64)}`;
  const resolution=resolved?{jobId:`supplement-${id}`,entryId:`entry-${id}`}:null;
  const learning=resolved?[
    {scope:agentId,decision:'adopt',version:1,at:observedAt-2000},
    {scope:'mother',decision:'adopt',version:1,at:observedAt-1000},
    {scope:agentId,decision:'retire',version:2,at:observedAt-3000},
  ].map(row=>({...row,reason:'隔离样本中的历史理由',entryId:`entry-${id}`,actor:{kind:'human',actorId:'fixture-human'}})):[];
  return {id,agentId,knowledgeJobId,state:invalid?'invalidated':resolved?'resolved':'review_required',
    reason:invalid?'source_unavailable':'independent_evidence_required',role:'model_generated',
    evidenceCount:0,userAcceptance:null,revision:invalid?null:1,resolution,learning,
    observation:{lineage:{agentId,designId:design?`design-${id}-${'c'.repeat(64)}`:null,runId:id,knowledgeJobId,
      ...(resolution?{resolutionJobId:resolution.jobId,entryId:resolution.entryId}:{})},
    linkState:invalid?'invalidated':'linked',generatedRole:'model_generated',resolutionRecorded:resolved,
    sourceCurrent:'not_checked',userAcceptance:null,latestDecisions:resolved?[learning[2],learning[1]]:[]}};
}
export function evidencePage(items,nextCursor=null){
  return {items,nextCursor,supported:true,coverage:{basis:'returned_page',returnedCount:items.length,hasMore:nextCursor!==null,observedAt}};
}
export function baseFixture(p){
  if(p==='/api/cultivation/overview')return {revision:1,state:'ready',policy:enabledPolicy(),agentCount:3,designCount:3,
    executorAvailable:true,motherIdentityAvailable:true,humanGrantAvailable:true,
    usage:{spent:0,reserved:0,unknown:0,currency:'USD',modelRequests:0},admission:{state:'idle'},taskStatus:{started:true,active:0}};
  if(p.startsWith('/api/cultivation/'))return {items:[],nextCursor:null,supported:true};
  if(p==='/api/sessions')return {sessions:[{id:'fixture',name:'隔离观察测试',group:'workspace'}]};
  if(p==='/api/models')return {models:[],cwd:'fixture'};
  if(p==='/api/persona')return {definition:{name:'隔离测试角色'},source:'file',problems:[],revision:'r1',history:[]};
  if(p==='/api/genome')return {genes:{},proposals:[],snapshots:[],reviews:[]};
  if(p==='/api/persona/confirmations')return {items:[],canApprove:false};
  if(p==='/api/time/tasks')return {tasks:[]};
  if(p==='/api/run/overview')return {active:[],recent:[],health:{status:'idle',activeCount:0,failedCount:0}};
  if(p.endsWith('/messages'))return {messages:[],truncated:false};
  return {};
}
