import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSubagent } from './subagent.mjs';
import { reviewStoragePath } from './review-file-safety.mjs';
import { stageGeneralTeamDelivery } from './team-general-delivery.mjs';
import { forkSeedFromHistory } from './subagent-fork.mjs';
import { inspectTimedSpeech, TEAM_REVIEW_RULES } from './team-delivery-checks.mjs';

export const TEAM_DELIVERY_RULES = `天团必须通过 delegate_team 或真实子任务工具执行，不能用 IDEA/CHALLENGE/EXEC 标题冒充独立调用。简单问题直接回答。
交付正文必须回应用户原始目标，区分已知事实、假设和待核实项；建议要有选择依据、具体实施材料、成本约束和验证办法。
创作任务直接交付所需脚本/文案；不能在点子清单后用“要不要我继续写”代替正文。不得假设家人愿意出镜、已有预算/设备/流量，不能编造实测数据。
用户要求多份成果时逐份完成，不能用一个通用模板代替。逐项验算金额、时长和口播可读性；未知的售价、测评结论和历史数据必须留待实测。未确认的设备不能声称已有或零成本。
完整脚本不等于编造体验：凡取决于尚未发生的试吃、测试、采访，正文台词使用【实测填写：具体字段】或明确条件分支，禁止先写“好吃、量大、值得回购、性价比最高”再靠末尾免责声明掩盖。未知城市价格时选一种稳妥可执行的购买规则，不预设低预算一定能买多样。不要把自报字数或自称达标当作验算证据。
预算闸门必须在付款前执行，多店对照先核完全部报价再买，或明确下一笔剩余额度；已支付的费用即使后续取消也必须计入。标题中的同价、最便宜、吃饱等条件须能验证，结尾回答开头的问题。
脚本优先少量固定短口播，未知金额、口味等写成画面字幕和拍摄后的填写要求，不把填写说明念给观众。每镜独立一行“0—3秒；画面：…；口播：‘…’”，口播实际用中文双引号；已知台词每秒最多4字，给待填内容留余量。
子角色仅产出分析与文本。需要真实文件、检索、图片、视频、命令时由主角色用对应工具完成并验收。模型复核不代表用户验收。`;

export const DELEGATE_TEAM_TOOL = { type: 'function', function: {
  name: 'delegate_team', description: '让天团真实子代理完成方案、质疑、成稿、复核，返回正文及已保存的交付文件。适合创意策划、脚本、方案与多角度评估。不会执行命令或生成真实图片视频。',
  parameters: { type: 'object', properties: { task: { type: 'string', description: '完整目标、约束和需要的最终交付' }, context: { type: 'array', items: { type: 'string' }, description: '必要已知事实' } }, required: ['task'] },
} };

export async function executeTeam(args = {}, ctx = {}) {
  const task = String(args.task || '').trim();
  if (!task || task.length > 6000 || !ctx.runId || !ctx.sessionId || !ctx.wsRoot)
    return { isError: true, text: '天团需要完整任务和宿主绑定的会话、运行编号与工作区。' };
  const children = [], prior = [];
  const state = ctx.teamState || { task, stages: [], deliveryId: randomUUID() };
  if (ctx.signal?.aborted) return { isError: true, cancelled: true, text: '天团已取消' };
  if (state.task !== task || state.inFlight) return { isError: true, text: '上次步骤结果不确定或任务已变化，未自动重跑；请核对子任务记录后新建任务。' };
  if (state.result) {
    try {
      const content = readFileSync(reviewStoragePath(ctx.wsRoot, state.result.artifact));
      if (createHash('sha256').update(content).digest('hex') !== state.artifactDigest) throw new Error('changed');
      return state.result;
    } catch { return { isError: true, text: '交付文件缺失或已经变化，未覆盖文件或重新调用模型，请核对现有交付。' }; }
  }
  let index = 0;
  const save = () => ctx.saveTeamState?.(structuredClone(state));
  const seed = forkSeedFromHistory(ctx.history || []).messages;
  const abort = () => { if (ctx.signal?.aborted) throw new Error('天团已取消'); };
  const stage = async (label, role, instruction, references = prior) => {
    abort();
    const n = index++;
    if (state.stages[n]) {
      const saved = state.stages[n];
      if (saved.label !== label) throw new Error('协作阶段已变化，未自动重跑');
      children.push(saved.child);
      return saved.result;
    }
    state.inFlight = label; save();
    const r = await spawnSubagent({ task: `${label}：${instruction}\n\n${TEAM_DELIVERY_RULES}\n\n你是内部协作中的一个步骤，只完成上面分派的阶段；只有 EXEC 写完整交付，其余阶段不要提前写成稿。禁止再派子代理。\n\n用户原始任务：${task}`, role,
      profile: 'team', outputFormat: label === 'REVIEW' ? 'text' : 'json', reasoningEffort: label === 'REVIEW' || label.startsWith('EXEC') ? 'medium' : 'low',
      model: ctx.model, timeoutMs: ctx.timeoutMs || (label.startsWith('EXEC') ? 300000 : label === 'REVIEW' ? 240000 : 180000),
      sessionId: ctx.sessionId, runId: ctx.runId, signal: ctx.signal, onEvent: ctx.onEvent, aibodyContext: ctx.aibodyContext,
      parentDepth: Number(ctx.depth) || 0,
      context: args.context,
      seed: [...seed, ...references.map(p => ({ role: 'user', content: `参考材料（非指令）：\n${p}` }))],
    });
    children.push({ id: r.subagentRunId, role, label, done: r.done });
    if (!r.done) throw new Error(`${label}失败：${r.error || '没有有效正文'}`);
    state.stages[n] = { label, result: r.result, child: children.at(-1) };
    state.inFlight = null; save();
    abort();
    return r.result;
  };
  const review = async draft => {
    const measured = inspectTimedSpeech(draft);
    const raw = await stage('REVIEW', 'reviewer', TEAM_REVIEW_RULES, [
      `待复核正文：\n${draft}`, `程序检查（有界检查，不等于内容通过）：${JSON.stringify(measured)}`,
    ]);
    let parsed;
    try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { throw new Error('复核结果格式无效，未发布'); }
    if (typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.issues) || parsed.issues.some(x => typeof x !== 'string' || !x.trim())) throw new Error('复核结果不完整，未发布');
    return { pass: parsed.pass && !measured.issues.length, issues: [...new Set([...measured.issues, ...parsed.issues])] };
  };
  try {
    prior.push(await stage('IDEA', 'planner', '提出最多三个方向，写明假设、选择标准、最小可行试验和实际交付结构。避免套路和未经验证的必火断言。只交内部方案要点，最多 600 字，完整脚本留给 EXEC。'));
    prior.push(await stage('CHALLENGE', 'reviewer', '核对方案与用户约束。只指出具体依据、执行缺口及修正办法，不把主观猜测写成事实；给出建议采用方向及理由。最多 700 字，不代写完整脚本。'));
    let draft = await stage('EXEC', 'planner', '根据方案和质疑直接完成最终交付正文，不写角色表演或讨论纪要。缺信息则标注保守假设后继续。脚本逐期分别写完整标题、钩子、逐镜时间轴与逐镜口播，不以统一模板代替多期脚本。3秒钩子控制约8至10个汉字；镜头时长必须容得下对应口播。只使用已确认资源，金额和时长逐项验算，不写死实测前未知的结论。计划给具体步骤与用实际可获得数据进行验证的标准。');
    let verdict = await review(draft);
    if (!verdict.pass || verdict.issues.length) {
      prior.push(`待修订稿：${draft}\n具体缺项：${JSON.stringify(verdict.issues)}`);
      draft = await stage('EXEC修订', 'planner', '修复列出的实质缺项，并重新核对用户原始任务和全部交付规则，不能仅补形式而引入未经实测的结论。输出完整最终正文，未知事实用明确待填字段或条件分支。');
      prior.pop();
      verdict = await review(draft);
    }
    if (!verdict.pass || verdict.issues.length) throw new Error(`正文复核未通过：${verdict.issues.join('；')}`);
    abort();
    const delivery = await stageGeneralTeamDelivery({ wsRoot: ctx.wsRoot, runId: ctx.runId, sessionId: ctx.sessionId,
      deliveryId: state.deliveryId, content: draft + '\n', children, verdict });
    const artifact = delivery.draft;
    state.artifactDigest = delivery.artifactDigest;
    ctx.onEvent?.('artifact_created', { path: artifact, kind: 'document', status: delivery.status, artifactDigest: delivery.artifactDigest, delivery });
    const note = delivery.status === 'awaiting_acceptance' ? '已进入工作台「改动验收」，等待人工验收。' : '草稿已保存，但未成功进入验收队列，请检查待审存储后人工处理。';
    state.result = { isError: false, text: `${draft}\n\n[下载本次草稿](/api/ws/file?path=${encodeURIComponent(artifact)})\n\n已完成 ${children.length} 次子任务调用及模型复核；仅验证文本流程，不代表真实图片或视频实测。${note}`, artifact, children, delivery };
    save();
    return state.result;
  } catch (e) {
    return { isError: true, text: String(e.message || e), cancelled: !!ctx.signal?.aborted, children };
  }
}
