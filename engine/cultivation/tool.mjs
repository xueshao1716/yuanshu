import {exact} from './control-state.mjs';
import {getTeamToolContext} from '../team-tool-context.mjs';

const actions=['overview','agents','designs','runs','experience','learning.context','design.submit','design.revise','agent.register','agent.adopt','run.submit','learning.decide','asset.bind'];
const description='智能体培养：先读取 overview 的 revision 和授权策略。由你自己设计，不能冒充用户批准。'+
  '读取 action=overview/agents/designs/runs/experience；写入 action=design.submit/design.revise/agent.register/agent.adopt/run.submit，'+
  '必须提供新 UUID requestId、expectedRevision、payload。design.submit payload={design}；design.revise={parentId,design}；'+
  'agent.register={designId}；agent.adopt={agentId,designId}；run.submit={agentId,input,goal,criterion}。'+
  'learning.decide={jobId,scope:原个体ID或mother,decision:adopt或retire,reason}，expectedRevision 使用知识记录版本。'+
  '采用须有独立来源；scope=mother 只有主人签名开启且仍有效的 motherLearning 事先授权才允许你自行决定，默认关闭，可被撤销；不得自行修改授权。'+
  '自主采用绑定当时控制版本，授权、设计或个体操作改变控制版本后需重新核验采用；不开启人格、基因基线或权限修改权。'+
  'learning.context 读取 payload={query}，仅返回所属个体已获人工分享批准或在有效事先授权内由你采用的相关知识；策略和设计须明确包含 dataScopes=[knowledge:approved-cultivation] 才能向模型发送知识。'+
  'asset.bind={agentId,kind:appearance或clothing或voice,path:workshop-out/内的相对文件路径}，只可绑定自己的个体；返回asset后提交并采用设计新版本。'+
  'design 必须包括 name,rationale,goals[],curriculum[],temporaryExpression,observation,recovery,'+
  'appearance/clothing/voice 各为 {description,asset:null 或 {id,version}},permissions={model,tools:[],dataScopes:[],remote,costUpperBoundCents},'+
  'protectedProposalRefs:[]。无真实设计时先向用户说明，不能预填演示人物。无独立证据的任务输出只是待核验假设；失败、取消或未知结果仅为执行记录，不是已核验知识。';
export const CULTIVATION_TOOL_SCHEMA={type:'function',function:{name:'cultivation',description,
  parameters:{type:'object',additionalProperties:false,properties:{action:{type:'string',enum:actions},
    requestId:{type:'string'},expectedRevision:{type:'integer',minimum:0},payload:{type:'object'}},required:['action']}}};
export async function cultivationTool(runtime,args,host) {
  try {
    if(!host?.executionIdentity||!args||!actions.includes(args.action))throw new Error('cultivation_identity_denied');
    const read=!args.action.includes('.')||args.action==='learning.context';
    if(read&&args.action!=='learning.context'&&!exact(args,['action']))throw new Error('cultivation_invalid_command');
    const result=read?await runtime.readMother(args,host.executionIdentity):await runtime.execute(args,'mother',host.executionIdentity);
    return {text:JSON.stringify(result),isError:false};
  }catch(error){return {text:/^cultivation_[a-z_]+$/.test(error?.message)?error.message:'cultivation_unavailable',isError:true};}
}
export function createPiCultivationTool(Type,getRuntime) {
  return {name:'cultivation',label:'智能体培养',description,parameters:Type.Object({action:Type.String(),
    requestId:Type.Optional(Type.String()),expectedRevision:Type.Optional(Type.Integer()),
    payload:Type.Optional(Type.Record(Type.String(),Type.Unknown()))},{additionalProperties:false}),
    async execute(_id,args){const result=await cultivationTool(getRuntime(),args,getTeamToolContext());
      return {content:[{type:'text',text:result.text}],isError:result.isError};}};
}
