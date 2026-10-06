import {exact} from './control-state.mjs';
import {getTeamToolContext} from '../team-tool-context.mjs';
import {CULTIVATION_DESIGN_SCHEMA} from './design-schema.mjs';
import {designValidationDetails} from './designs.mjs';
import {cultivationFailureDetails} from './diagnostics.mjs';

const actions=['overview','agents','designs','runs','experience','preflight','models','denials','learning.context','design.submit','design.revise','agent.register','agent.adopt','run.submit','learning.decide','asset.bind'];
const description='智能体培养：由小语自己设计和推进，先在对话里向主人说明方案；主人只需查看方案并做最终放权确认，不能冒充用户批准。培养设计只描述目标、课程和文本任务，不向主人索取课程、模型参数、电脑密码或其他凭据。'+
  '登记前用 preflight,payload={action:"design.check",designId} 检查设计、模型、价格和共享配额；操作前也可用 action:agent.register或run.submit或run.dispatch 配合 designId或agentId 一次查看 blockedBy；只读，不注册、不预留、不调用模型。'+
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
  '本阶段tools=[]是正常且推荐的文本培养设计，不要为让个体能工作而加工具；培养设计不得包含电脑、文件、终端、密码或凭据权限，电脑操作另有独立授权且默认关闭；HTTP模型需要remote=true，只有用户策略已明确允许时才可修订此标记。'+
  '无真实设计时先向用户说明，不能预填演示人物。无独立证据的任务输出只是待核验假设；失败、取消或未知结果仅为执行记录，不是已核验知识。';
const recovery = Object.freeze({
  cultivation_identity_denied:'本轮没有母体执行身份（不是被拒，是这一轮根本没带身份）：培养工具只在伙伴亲自发起的对话里可用，即元枢网页对话，或伙伴本人扫码绑定的微信号发来的消息；陌生微信联系人、定时任务、语音任务和 /team 子任务里没有这个身份。这不是授权问题，授权页改什么都没用，不要让伙伴去点开关；把要做的培养操作记下来，等伙伴本人发起下一轮时再做。',
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
    // 动作名拼错（真机：design.rev）不是身份问题——报 identity_denied 会让模型以为没权限、转去找人授权。
    if(args&&typeof args==='object'&&!actions.includes(args.action))
      return {text:JSON.stringify({error:'cultivation_unknown_action',retryable:true,got:String(args.action??''),
        expected:actions,nextAction:'动作名必须完全匹配 expected 里的一项（如 design.revise，不能缩写），改正后用新 requestId 重试。'}),isError:true};
    if(!host?.executionIdentity||!args)throw new Error('cultivation_identity_denied');
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
