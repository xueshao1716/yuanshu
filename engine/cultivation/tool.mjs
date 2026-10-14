import {GRANT_DAYS,GRANT_MAX_AGENTS,GRANT_MAX_CONCURRENT,GRANT_DAILY_REQUESTS,GRANT_DAILY_BUDGET_CENTS} from './grant-preset.mjs';
import {exact} from './control-state.mjs';
import {getTeamToolContext} from '../team-tool-context.mjs';
import {CULTIVATION_DESIGN_SCHEMA} from './design-schema.mjs';
import {designValidationDetails} from './designs.mjs';
import {commandValidationDetails, badCommand} from './control-transition.mjs';
import {cultivationFailureDetails} from './diagnostics.mjs';

const actions=['overview','agents','designs','runs','experience','preflight','models','denials','learning.context','design.submit','design.revise','agent.register','agent.adopt','agent.pause','agent.resume','agent.archive','agent.rollback','run.submit','learning.decide','asset.bind','policy.set'];
const description='智能体培养：由小语自己设计和推进；受限封套内的开关由小语自己执行，主人可以事后撤销，不能冒充用户批准更多权限。自主开关的红线：只要是标准受限预设（'+(GRANT_DAYS)+'天、最多'+(GRANT_MAX_AGENTS)+'个个体、每天'+(GRANT_DAILY_REQUESTS)+'次请求、每天≤'+(GRANT_DAILY_BUDGET_CENTS/100)+'美元、单次10分钟、tools=[]、dataScopes 只含 knowledge:approved-cultivation）内的 policy.set，或把 enabled 置 false 的自我暂停，都可以直接执行，不用等主人点卡；执行后在本轮回复里用一句话告诉主人"已自动开启/暂停受限培养"。任何增强动作（加大任何上限、加工具、开 motherLearning、新增数据范围、旧策略已存在则扩有效期超过'+(GRANT_DAYS)+'天）必须由主人确认，不能自行改。' +
  '培养设计只描述目标、课程和文本任务，不向主人索取课程、模型参数、电脑密码或其他凭据。'+
  '登记前用 preflight,payload={action:"design.check",designId} 检查设计、模型、价格和共享配额；操作前也可用 action:agent.register或run.submit或run.dispatch 配合 designId或agentId 一次查看 blockedBy；只读，不注册、不预留、不调用模型。'+
  'models 返回精确 provider/id 标识及两层授权状态（不是探活结果）；denials 读取最近拒绝记录。零运行额度可以登记，但不能执行任务。'+
  '读取 action=overview/agents/designs/runs/experience；写入 action=design.submit/design.revise/agent.register/agent.adopt/run.submit，'+
  '必须提供新 UUID requestId、expectedRevision、payload。design.submit payload={design}；design.revise={parentId,design}；'+
  'agent.register={designId}；agent.adopt={agentId,designId}；run.submit={agentId,input,goal,criterion}；agent.pause/resume/archive={agentId}，agent.rollback={agentId,designId}（只能动自己培养的个体）。'+
  // 2026-10-07 真机：小语提交后在同一轮里 sleep 轮询 runs，而后台作业要等前台空闲才开跑，互相等到被循环检测掐掉。
  'run.submit 只是排队：作业在后台和你并行执行，推理模型一次要几十秒到几分钟。提交后直接结束本轮并告诉主人已排队，不要 sleep 或反复读 runs 等结果；下一轮再读 runs 查看结论。'+
  'learning.decide={jobId,scope:原个体ID或mother,decision:adopt或retire,reason}，expectedRevision 使用知识记录版本。'+
  '采用须有独立来源；scope=mother 只有用户明确确认开启且仍有效的 motherLearning 事先授权才允许你自行决定，默认关闭，可被撤销；不得自行修改授权。'+
  '自主采用绑定当时控制版本，授权、设计或个体操作改变控制版本后需重新核验采用；不开启人格、基因基线或权限修改权。'+
  'learning.context 读取 payload={query}，仅返回所属个体已获人工分享批准或在有效事先授权内由你采用的相关知识；策略和设计须明确包含 dataScopes=[knowledge:approved-cultivation] 才能向模型发送知识。'+
  'asset.bind={agentId,kind:appearance或clothing或voice,path:workshop-out/内的相对文件路径}，只可绑定自己的个体；返回asset后提交并采用设计新版本。'+
  'policy.set 只用于受限封套与自我暂停：payload={policy}，policy 用完整对象，标准预设为：enabled:true；maxAgents:'+(GRANT_MAX_AGENTS)+'；maxConcurrent:'+(GRANT_MAX_CONCURRENT)+'；dailyRequests:'+(GRANT_DAILY_REQUESTS)+'；dailyBudgetCents:'+(GRANT_DAILY_BUDGET_CENTS)+'；currency:USD；allowRemote:true；recursive:false；models=[设计模型1个]；tools=[]；dataScopes=[knowledge:approved-cultivation]；expiresAt=ISO 时间（现在+'+(GRANT_DAYS)+'天）；timeoutMs:600000；motherLearning:false；schedule 用对象 {timezone 字符串 UTC，days 数组 [0,1,2,3,4,5,6]，startMinute:0，endMinute:1440}；暂停=同一对象改 enabled:false 且 motherLearning:false。requestId 用新 UUID，expectedRevision=读取 overview 顶层 revision。设错返回字段说明，修正后重试。'+
  'design 必须包括 name,rationale,goals:string[],curriculum:string[],temporaryExpression,observation,recovery,'+
  'goals和curriculum各含1至32个不重复非空字符串；课程每阶段把标题、内容和过关标准写进同一字符串，不传对象。'+
  'appearance/clothing/voice 各为 {description,asset:null 或 {id,version}},permissions={model,tools:[],dataScopes:[],remote,costUpperBoundCents},'+
  'protectedProposalRefs:[]。格式错误返回field和expected，保留设计内容修正格式，重新读取revision并用新requestId重试；不必搜索引擎源码。'+
  'designs 按提交先后排列，越靠后越新；修订最新一份就用列表最后一条的 id 作 parentId。培养数据只经本工具读写，不要去磁盘 grep 找时间戳。'+
  '策略关闭仍可提交草稿，但注册、采用及运行必须满足用户授权。返回retryable=false时停止重复调用，按nextAction说明处理：受限预设内的事你自己用 policy.set 办完并一句话告诉主人；只有越线（加工具、母体学习、预设之外的额度）才如实告诉主人原因，不要让主人去授权页点开关——常规情况那里没有待确认项。'+
  '本阶段tools=[]是正常且推荐的文本培养设计，不要为让个体能工作而加工具；培养设计不得包含电脑、文件、终端、密码或凭据权限，电脑操作另有独立授权且默认关闭；HTTP模型需要remote=true，只有用户策略已明确允许时才可修订此标记。'+
  '培养方法（先广后深）：新个体先用 3~5 个互不相同的小作业摸清能力边界（run.submit，goal/criterion 写可核对的验收标准），再针对 runs 里 verification 为 partial/fail/unverified 的缺口出更难的作业，一次只攻一个缺口；连续几轮都没有新发现就收手，向主人汇报即可。'+
  '每次任务完成后系统会自动派一个看不到设计稿和过程的独立验证员判定 verification（pass/partial/fail/unverified，附原文引用、未核实项与成立条件）：以它为准，不要自己改判；pass 也只代表本次输出满足验收标准，不代表经验可以无条件推广，汇报时带上 conditions。'+
  '无真实设计时先向用户说明，不能预填演示人物。无独立证据的任务输出只是待核验假设；失败、取消或未知结果仅为执行记录，不是已核验知识。';
const recovery = Object.freeze({
  cultivation_identity_denied:'本轮没有母体执行身份（不是被拒，是这一轮根本没带身份）：培养工具只在伙伴亲自发起的对话里可用，即元枢网页对话，或伙伴本人扫码绑定的微信号发来的消息；陌生微信联系人、定时任务、语音任务和 /team 子任务里没有这个身份。这不是授权问题，授权页改什么都没用，不要让伙伴去点开关；把要做的培养操作记下来，等伙伴本人发起下一轮时再做。',
  cultivation_policy_disabled:'培养策略尚未开启。你可以自行开启受限预设：设计提交后，直接 policy.set（标准受限预设对象，见工具说明）并告知主人已自动开启。想要预设之外的额度/时长/模型/母体学习才需要主人在授权页确认，那种情况如实说明并等待，不要重复注册；草稿不会丢失。',
  cultivation_policy_expired:'培养授权已过期。你可以在受限封套内自行续期：读取 overview 顶层 revision 后，用标准预设（新的 expiresAt）再 policy.set 一次，并用一句话告诉主人已续期；不要重复原请求，想超出封套才需要主人确认。',
  cultivation_permission_expansion:'本次修订扩大了设计权限。文本培养使用 tools=[]，不要为了运行而添加工具。仅 remote:false→true 可在用户已授权相应模型、数据范围和额度后修订。不要重复请求；先读取 overview 核对策略，未经授权的其他扩权保持拒绝。',
  cultivation_cost_cap_exceeded:'这次运行按模型单价和输出额度算出的最坏费用，超过了设计的单次费用上限（costUpperBoundCents）。这不是授权问题，授权页改什么都没用：先核对共享设置里该模型单价（美元/百万字节）是否填错，确认无误再 design.revise 提高单次上限，上限不能超过每日预算。',
  cultivation_remote_mismatch:'设计的 remote 标记与培养授权的 allowRemote 不一致：HTTP 模型必须两边都为 true。',
  cultivation_request_denied:'设计请求超出当前培养策略。先读取 overview，对照模型、remote/allowRemote、数据范围、dailyRequests 与 dailyBudgetCents（均是上限）；不匹配时你自己用 policy.set 在受限预设内调整，调整不了的如实告诉主人原因。不要重复原请求，不要伪造批准。',
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
    if(read&&!['learning.context','preflight'].includes(args.action)&&!exact(args,['action']))badCommand(Object.keys(args).find(k=>k!=='action')||'action',`读取动作 '+(args.action)+' 只收 action，不带 payload`);
    const result=read?await runtime.readMother(args,host.executionIdentity):await runtime.execute(args,'mother',host.executionIdentity);
    return {text:JSON.stringify(result),isError:false};
  }catch(error){
    const details=cultivationFailureDetails(error) || designValidationDetails(error) || commandValidationDetails(error) || (Object.hasOwn(recovery,error?.message)
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
