import {exact} from './control-state.mjs';
import {getTeamToolContext} from '../team-tool-context.mjs';
import {CULTIVATION_DESIGN_SCHEMA} from './design-schema.mjs';
import {designValidationDetails} from './designs.mjs';
import {cultivationFailureDetails} from './diagnostics.mjs';

const actions=['overview','agents','designs','runs','experience','preflight','models','denials','learning.context','design.submit','design.revise','agent.register','agent.adopt','run.submit','learning.decide','asset.bind'];
const description='智能体培养：先读取 overview 的 revision 和授权策略。由你自己设计，不能冒充用户批准。'+
  '操作前用 preflight,payload={action:agent.register或run.submit或run.dispatch,designId或agentId} 一次查看 blockedBy；只读，不注册、不预留、不调用模型。'+
  'models 返回精确 provider/id 标识及两层授权状态（不是探活结果）；denials 读取最近拒绝记录。零运行额度可以登记，但不能执行任务。'+
  '读取 action=overview/agents/designs/runs/experience；写入 action=design.submit/design.revise/agent.register/agent.adopt/run.submit，'+
  '必须提供新 UUID requestId、expectedRevision、payload。design.submit payload={design}；design.revise={parentId,design}；'+
  'agent.register={designId}；agent.adopt={agentId,designId}；run.submit={agentId,input,goal,criterion}。'+
  'learning.decide={jobId,scope:原个体ID或mother,decision:adopt或retire,reason}，expectedRevision 使用知识记录版本。'+
  '采用须有独立来源；scope=mother 只有用户明确确认开启且仍有效的 motherLearning 事先授权才允许你自行决定，默认关闭，可被撤销；不得自行修改授权。'+
  '自主采用绑定当时控制版本，授权、设计或个体操作改变控制版本后需重新核验采用；不开启人格、基因基线或权限修改权。'+
  'learning.context 读取 payload={query}，仅返回所属个体已获人工分享批准或在有效事先授权内由你采用的相关知识；策略和设计须明确包含 dataScopes=[knowledge:approved-cultivation] 才能向模型发送知识。'+
  'asset.bind={agentId,kind:appearance或clothing或voice,path:workshop-out/内的相对文件路径}，只可绑定自己的个体；返回asset后提交并采用设计新版本。'+
  'design 必须包括 name,rationale,goals:string[],curriculum:string[],temporaryExpression,observation,recovery,'+
  'goals和curriculum各含1至32个不重复非空字符串；课程每阶段把标题、内容和过关标准写进同一字符串，不传对象。'+
  'appearance/clothing/voice 各为 {description,asset:null 或 {id,version}},permissions={model,tools:[],dataScopes:[],remote,costUpperBoundCents},'+
  'protectedProposalRefs:[]。格式错误返回field和expected，保留设计内容修正格式，重新读取revision并用新requestId重试；不必搜索引擎源码。'+
  '策略关闭仍可提交草稿，但注册、采用及运行必须满足用户授权。返回retryable=false时停止重复调用，按nextAction说明等待用户在授权与资源中会话确认。'+
  '本阶段tools=[]是正常的文本任务设计，不要为让个体能工作而加工具；HTTP模型需要remote=true，只有用户策略已明确允许时才可修订此标记。'+
  '无真实设计时先向用户说明，不能预填演示人物。无独立证据的任务输出只是待核验假设；失败、取消或未知结果仅为执行记录，不是已核验知识。';
const recovery = Object.freeze({
  cultivation_policy_disabled:'培养策略尚未开启。请用户到灵魂培养中心 → 智能体培养 → 授权与资源，选择真实设计并核对七天受限培养，完成会话确认。确认前不要重复注册；草稿不会因此丢失。',
  cultivation_policy_expired:'培养授权已过期。请用户在授权与资源中核对并重新确认有效期与额度；不要重复原请求，也不要自行续期。',
  cultivation_permission_expansion:'本次修订扩大了设计权限。文本培养使用 tools=[]，不要为了运行而添加工具。仅 remote:false→true 可在用户已授权相应模型、数据范围和额度后修订。不要重复请求；先读取 overview 核对策略，未经授权的其他扩权保持拒绝。',
  cultivation_request_denied:'设计请求超出当前培养策略。先读取 overview，对照模型、remote/allowRemote、数据范围、dailyRequests 与 dailyBudgetCents（均是上限）；不匹配时请用户在授权与资源中核对。不要重复原请求，不要伪造批准。',
});
export const CULTIVATION_TOOL_SCHEMA={type:'function',function:{name:'cultivation',description,
  parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:actions},
    requestId:{type:'string'},expectedRevision:{type:'integer',minimum:0},
    payload:{type:'object',properties:{design:CULTIVATION_DESIGN_SCHEMA}}},required:['action']}}};
export async function cultivationTool(runtime,args,host) {
  try {
    if(!host?.executionIdentity||!args||!actions.includes(args.action))throw new Error('cultivation_identity_denied');
    const read=!args.action.includes('.')||args.action==='learning.context';
    if(read&&!['learning.context','preflight'].includes(args.action)&&!exact(args,['action']))throw new Error('cultivation_invalid_command');
    const result=read?await runtime.readMother(args,host.executionIdentity):await runtime.execute(args,'mother',host.executionIdentity);
    return {text:JSON.stringify(result),isError:false};
  }catch(error){
    const details=cultivationFailureDetails(error) || designValidationDetails(error) || (Object.hasOwn(recovery,error?.message)
      ? {error:error.message,retryable:false,nextAction:recovery[error.message]} : null);
    return {text:details?JSON.stringify(details):/^cultivation_[a-z_]+$/.test(error?.message)?error.message:'cultivation_unavailable',isError:true};
  }
}
export function createPiCultivationTool(Type,getRuntime) {
  return {name:'cultivation',label:'智能体培养',description,
    parameters:Type.Unsafe(CULTIVATION_TOOL_SCHEMA.function.parameters),
    async execute(_id,args){const result=await cultivationTool(getRuntime(),args,getTeamToolContext());
      return {content:[{type:'text',text:result.text}],isError:result.isError};}};
}
