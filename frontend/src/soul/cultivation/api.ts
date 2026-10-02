import { api } from '../../api'
export const cultivationPolling = {refreshInterval:30000,refreshWhenHidden:false,refreshWhenOffline:false}
export type ExperienceCoverage = {basis:'returned_page';returnedCount:number;hasMore:boolean;observedAt:number}
export type ExperienceObservation = {
  lineage:{agentId:string;designId:string|null;runId:string;knowledgeJobId:string;resolutionJobId?:string;entryId?:string};
  linkState:'linked'|'invalidated';generatedRole:'model_generated'|'execution_record';resolutionRecorded:boolean;
  sourceCurrent:'not_checked';userAcceptance:null;
  latestDecisions:{scope:string;decision:'adopt'|'retire';version:number;at:number;entryId?:string;actor:{kind:string|null}}[]
}
export type Page<T> = {items:T[]; nextCursor:string|null; supported:boolean; revision?:number;coverage?:ExperienceCoverage}
export type MediaDesign = {description:string; asset:null|{id:string;version:number}}
export type Design = {id:string;parentId:string|null;author:{actorId:string};design:{
  name:string;rationale:string;goals:string[];curriculum:string[];temporaryExpression:string;
  observation:string;recovery:string;appearance:MediaDesign;clothing:MediaDesign;voice:MediaDesign;
  permissions:{model:string;tools:string[];dataScopes:string[];remote:boolean;costUpperBoundCents:number}}}
export type Agent = {id:string;mentorId:string;designId:string;history:string[];status:string;cancellation:string}
export type AgentDetail = {agent:Agent;design:Design;revision:number;initialization:string}
export type Run = {id:string;status:string;createdAt:string;updatedAt:string;error?:{message?:string};
  cultivation:{agentId:string;designId:string;reason?:string;output?:string|null;knowledgeJobId?:string}}
export type Experience = {id:string;agentId:string;knowledgeJobId:string;state:string;reason:string;observation?:ExperienceObservation;
  outcome?:'failed'|'cancelled'|'unknown'|'not_completed';
  evidenceCount:number;userAcceptance:null;role:string;resolution:null|{jobId:string;entryId:string};revision:number|null;
  learning:{scope:string;decision:'adopt'|'retire';reason:string;version:number;at:number;actor:{kind:string;actorId:string}}[]}
export type Policy = {enabled:boolean;motherLearning?:boolean;maxAgents:number;maxConcurrent:number;dailyRequests:number;
  dailyBudgetCents:number;currency:string;allowRemote:boolean;recursive:boolean;expiresAt:string|null;
  models:string[];tools:string[];dataScopes:string[];schedule:null|{timezone:string;days:number[];startMinute:number;endMinute:number};timeoutMs:number}
export type Overview = {revision:number;state:string;policy:Policy;agentCount:number;designCount:number;
  ownerConfirmation?:{mode:'windows-hello'|'external-signature'|'unavailable';state:string;workspace:string};
  executorAvailable:boolean;motherIdentityAvailable:boolean;humanGrantAvailable:boolean;
  sessionGrantAvailable:boolean;
  usage:null|{spent:number;reserved:number;unknown:number;currency:string;modelRequests:number};
  admission:null|{state:'idle'|'held';id?:string;consumer?:string;recoveryRequired?:boolean};
  taskStatus:null|{started:boolean;active:number;lastError?:string}}
export type Command = {method:'PUT'|'POST';path:string;body:{requestId:string;expectedRevision:number;payload:unknown}}
export type Challenge = {id:string;message:string;expiresAt:number}
export type SessionChallenge = {id:string;sessionId:string;commandHash:string;expiresAt:number}
export type SessionProof = {id:string;sessionId:string;token:string;expiresAt:number}
export type PreflightQuery = {action:string;designId?:string;agentId?:string}
export type Blocker = {code:string;field:string;message:string;nextAction:string}
export type Preflight = {action:string;revision:number;ready:boolean;retryable:boolean;checkedAt:string;
  blockedBy:Blocker[];warnings:Blocker[];nextAction:string;scope:'configuration_only'}
export type ModelCatalog = {available:boolean;reason?:string;revision?:number;models:{key:string;label:string;
  cultivationAuthorized:boolean;sharedAuthorized:boolean;health:'not_checked'}[]}
export type Denials = {retained:number;limit:number;items:{requestId:string;action:string;error:string;
  expectedRevision:number;count:number;lastAt:string;outcome:'denied'}[]}
export const CultivationApi = {
  overview:()=>api<Overview>('/api/cultivation/overview'),
  preflight:(query:PreflightQuery)=>api<Preflight>(`/api/cultivation/preflight?${new URLSearchParams(Object.entries(query))}`),
  models:()=>api<ModelCatalog>('/api/cultivation/models'),
  denials:()=>api<Denials>('/api/cultivation/denials'),
  list:<T,>(kind:string,cursor:string|null)=>api<Page<T>>(`/api/cultivation/${kind}?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`),
  agent:(id:string)=>api<AgentDetail>(`/api/cultivation/agents/${encodeURIComponent(id)}`),
  media:(agentId:string,kind:string,asset:{id:string;version:number})=>api<{mime:string;base64:string}>(
    `/api/cultivation/media?${new URLSearchParams({agentId,kind,id:asset.id,version:String(asset.version)})}`),
  challenge:(command:Command)=>api<Challenge>('/api/cultivation/grants/challenge',{method:'POST',body:command}),
  sessionChallenge:(command:Command,sessionId:string)=>api<SessionChallenge>('/api/cultivation/grants/session/challenge',
    {method:'POST',body:{...command,sessionId}}),
  sessionConfirm:(challenge:SessionChallenge,command:Command,sessionId:string)=>api<SessionProof>('/api/cultivation/grants/session/confirm',
    {method:'POST',body:{id:challenge.id,method:command.method,path:command.path,body:command.body,sessionId}}),
  execute:(command:Command,proof:{id:string;signature:string}|SessionProof,sessionId?:string)=>api('/api/cultivation'+command.path,
    {method:command.method,body:command.body,headers:'signature' in proof
      ? {'x-cultivation-proof':JSON.stringify(proof)}
      : {'x-cultivation-session-proof':JSON.stringify(proof),'x-cultivation-session-id':sessionId||proof.sessionId}}),
}
const labels:Record<string,string>={ready:'就绪',paused:'已暂停',archived:'已归档',queued:'排队中',running:'运行中',stopping:'正在停止',completed:'已完成',failed:'失败',stopped:'已停止',interrupted:'已中断',review_required:'待独立核查',resolved:'已有补证记录',invalidated:'来源已失效'}
export const statusLabel=(value:string)=>labels[value]||value
