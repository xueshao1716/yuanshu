// 隔离子任务执行器：可追溯生命周期台账 + 三种画像（权限表集中在下方 TEAM_MEMBER_* / resolveToolPolicy）。
//   analysis：一次纯文本分析调用（补全/调试接口沿用）。
//   research：只读研究员——有界工具循环（read/list/grep/web_search，见 subagent-research.mjs），
//             不写文件、不跑命令；delegate_task / delegate_fork 走这一种。
//   team：天团成员——只读检索 + 团队共享看板（team_board，能领/完/放不能建），有轮次与总调用预算，
//         每次工具调用写动作审计（标注 member / teamId）；仍然不能写文件、跑命令、生图生视频、再派活。
import { HttpModelAdapter } from "./model/adapter.mjs";
import { RESEARCH_TOOLS, RESEARCH_MAX_STEPS, RESEARCH_TOOL_NAMES, createResearchExecutor } from "./subagent-research.mjs";
import { TEAM_BOARD_TOOL, executeTeamBoard } from "./team-board.mjs";
import { auditPath, summarizeArgs } from "./tools/audit-gate.mjs";
import { redactSecrets } from "./tools/secrets-guard.mjs";
import { nextSubagentDepth, DEFAULT_MAX_DEPTH } from "./subagent-depth.mjs";
import fs from "node:fs";
import path from "node:path";
import { explicitSubagentInput, subagentBudget, subagentResponseDiagnostics, parseSubagentResult } from './subagent-contract.mjs';
import {
  configureSubagentTraces,
  getSubagentHistory as readSubagentHistory,
  historyFromMemory,
  rememberInMemoryTrace,
  safeEvidence,
  safeRole,
} from "./subagent-traces.mjs";

let _adapter = null;
let _adapterOptions = null;
let _getDefaultModel = () => null;
let _getFlashModel = () => null;
let _traceStore = configureSubagentTraces();
let _ordinal = 0;
let _research = null;
let _researchRoots = null;

// ===== 天团成员工具权限表（2026-11-15）· 唯一判定处 =====
// 成员只"查"和"认领"：写文件 / 跑命令 / 生图生视频 / 再派活一律不给。
// 以后扩工具只改这几张表 + resolveToolPolicy / judgeTeamMemberTool，不要在 spawnSubagent 里散落 if。
export const TEAM_MEMBER_READ_TOOLS = Object.freeze(["read", "list", "grep", "web_search"]);
export const TEAM_MEMBER_BOARD_TOOL = "team_board";
export const TEAM_MEMBER_TOOLS = Object.freeze([...TEAM_MEMBER_READ_TOOLS, TEAM_MEMBER_BOARD_TOOL]);
// 成员只能领活不能造活：create 由主控在开局时预建（team-launch / executeTeam）。
export const TEAM_MEMBER_BOARD_ACTIONS = Object.freeze(["list", "summary", "claim", "complete", "release"]);
export const TEAM_MEMBER_MAX_STEPS = 12;
export const TEAM_MEMBER_MAX_TOOL_CALLS = 40;
// 明确不给的工具名：只用于说明与测试断言，真正的拦截是"工具表里根本没有"。
export const TEAM_MEMBER_DENIED_TOOLS = Object.freeze([
  "write", "edit", "apply_patch", "bash", "run_command", "run_code", "execute",
  "generate_image", "generate_video", "image_gen", "video_gen",
  "delegate_task", "delegate_fork", "delegate_team", "spawn_agent",
]);

/** 成员版 team_board：动作枚举去掉 create，团队编号由宿主固定（成员不能换板子）。 */
function memberBoardTool() {
  const base = TEAM_BOARD_TOOL.function;
  const properties = { ...base.parameters.properties };
  delete properties.teamId;
  return {
    type: "function",
    function: {
      name: base.name,
      description: "团队共享任务看板（成员版）：只能 list / summary / claim / complete / release，**不能 create**（任务由主控预建）。"
        + "纪律：① 开工前先 list（ready:true 只看就绪且没人占的）；② claim 必须带 expectedRevision（list 返回的 revision），"
        + "不一致=有人先改过，不要盲覆盖；③ 做完立刻 complete 并写 result；④ 卡住或做不了就 release，别占着坑。"
        + "看板只是协作清单，不替代交付。",
      parameters: {
        ...base.parameters,
        properties: {
          ...properties,
          action: { type: "string", enum: [...TEAM_MEMBER_BOARD_ACTIONS], description: "list 列任务 / summary 总览 / claim 认领 / complete 完成 / release 释放" },
        },
      },
    },
  };
}

const TEAM_MEMBER_TOOL_DEFS = Object.freeze([
  ...RESEARCH_TOOLS.filter(tool => TEAM_MEMBER_READ_TOOLS.includes(tool.function.name)),
  memberBoardTool(),
]);

const NO_TOOL_POLICY = Object.freeze({ kind: "none", toolNames: Object.freeze([]), tools: Object.freeze([]), maxSteps: 0, maxToolCalls: 0, longForm: false });

/** 唯一工具权限判定：profile + 本宿主可用的执行器 → 本轮工具表与预算。 */
export function resolveToolPolicy(profile = "analysis", { outputFormat = "json", readTools = false, board = false } = {}) {
  if (profile === "team") {
    const toolNames = [...(readTools ? TEAM_MEMBER_READ_TOOLS : []), ...(board ? [TEAM_MEMBER_BOARD_TOOL] : [])];
    // 没有工具（例如没绑 teamId 的裸 team 调用）仍保持"长任务"预算语义，与旧行为一致。
    if (!toolNames.length) return Object.freeze({ ...NO_TOOL_POLICY, longForm: true });
    return Object.freeze({
      kind: "team",
      toolNames: Object.freeze(toolNames),
      tools: Object.freeze(TEAM_MEMBER_TOOL_DEFS.filter(tool => toolNames.includes(tool.function.name))),
      maxSteps: TEAM_MEMBER_MAX_STEPS,
      maxToolCalls: TEAM_MEMBER_MAX_TOOL_CALLS,
      longForm: true,
    });
  }
  if (profile === "research" && outputFormat === "json" && readTools) {
    return Object.freeze({ kind: "research", toolNames: RESEARCH_TOOL_NAMES, tools: RESEARCH_TOOLS, maxSteps: RESEARCH_MAX_STEPS, maxToolCalls: Infinity, longForm: false });
  }
  return NO_TOOL_POLICY;
}

/** 单个成员工具调用 → 放行/拒绝（拒绝必须回明确说明，不静默丢弃）。 */
export function judgeTeamMemberTool(name) {
  const tool = String(name || "").trim();
  if (TEAM_MEMBER_READ_TOOLS.includes(tool)) return { ok: true, kind: "read" };
  if (tool === TEAM_MEMBER_BOARD_TOOL) return { ok: true, kind: "board" };
  return { ok: false, kind: "denied", text: `⛔ 天团成员没有「${tool || "（空工具名）"}」这个工具：可用只有 ${TEAM_MEMBER_TOOLS.join(" / ")}。你不能写文件、运行命令、生成图片/视频或再派子代理；请改用只读工具，或在正文里说明这一步需要主代理来完成。` };
}

/** 看板动作的成员版权限：能领、能成交、能释放，不能 create。 */
export function judgeTeamBoardAction(args = {}) {
  const action = String(args?.action || "").trim();
  if (TEAM_MEMBER_BOARD_ACTIONS.includes(action)) return { ok: true, action };
  if (action === "create") return { ok: false, text: "⛔ 天团成员不能 create 看板任务：成员只领活、不造活，任务由主控在开局时预建。可用动作只有 " + TEAM_MEMBER_BOARD_ACTIONS.join(" / ") + "。" };
  return { ok: false, text: `⛔ 看板 action 必须是 ${TEAM_MEMBER_BOARD_ACTIONS.join(" / ")}（成员没有 create 权限）` };
}

function resolveAuditRoot(wsRoot) {
  const explicit = String(wsRoot || "").trim();
  if (explicit) return explicit;
  try {
    const roots = typeof _researchRoots === "function" ? _researchRoots() : _researchRoots;
    return String(roots?.[0] || "").trim();
  } catch { return ""; }
}

/** 成员工具调用先落一行审计（写不进去默认不执行，与主代理审计闸门同向）。 */
function appendMemberAudit(wsRoot, row) {
  try {
    const file = auditPath(wsRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
    return true;
  } catch { return false; }
}

async function runTeamMemberTool(name, args, ctx) {
  const verdict = judgeTeamMemberTool(name);
  if (!verdict.ok) return { text: verdict.text, isError: true, denied: true };
  if (verdict.kind === "read") {
    if (typeof ctx.read !== "function") return { text: `⛔ 只读检索执行器未接入，无法执行「${name}」；请在正文里说明这个缺口。`, isError: true };
    return ctx.read(name, args);
  }
  const action = judgeTeamBoardAction(args);
  if (!action.ok) return { text: action.text, isError: true, denied: true };
  const boardArgs = { ...args, action: action.action, teamId: ctx.teamId };
  // 认领/完成/释放的 owner 由宿主固定为成员名，避免成员替别人认领或完成。
  if (["claim", "complete", "release"].includes(action.action)) boardArgs.owner = ctx.member;
  return executeTeamBoard(boardArgs, { wsRoot: ctx.wsRoot, teamId: ctx.teamId });
}

async function runAuditedTeamMemberTool(tc, args, { ctx, allowExecution, maxToolCalls }) {
  const name = String(tc?.function?.name || "");
  const summary = summarizeArgs(args);
  const auditRoot = ctx.auditRoot;
  const base = {
    at: Date.now(), tool: name, initiator: "subagent",
    session: ctx.sessionId, runId: ctx.subagentRunId, parentRunId: ctx.parentRunId,
    member: ctx.member, teamId: ctx.teamId, argsHash: summary.hash, argsPreview: summary.preview, argsBytes: summary.bytes,
  };
  if (auditRoot && !appendMemberAudit(auditRoot, { ...base, phase: "before" }) && process.env.YUANSHU_AUDIT_SOFT !== "1") {
    return { out: { text: "⛔ 动作审计写不进去，本次工具调用未执行（无记录不许行动）。请在正文里说明这个缺口。", isError: true }, executed: false };
  }
  let out;
  let executed = false;
  if (!allowExecution) out = { text: `⛔ 工具调用总预算已用完（${maxToolCalls} 次），本次「${name}」未执行；请直接收尾出稿。`, isError: true };
  else { out = await runTeamMemberTool(name, args, ctx); executed = !out?.denied; }
  if (auditRoot) {
    appendMemberAudit(auditRoot, {
      ...base, phase: "after", ok: !out?.isError, ms: Date.now() - base.at,
      error: out?.isError ? String(out.text || "").slice(0, 160) : "",
      resultPreview: redactSecrets(String(out?.text || "")).slice(0, 200),
    });
  }
  return { out, executed };
}


function makeId(prefix = "subagent") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function abortError(message = "子任务已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function combineSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const abort = () => { if (!controller.signal.aborted) controller.abort(); };
  if (parentSignal) {
    if (parentSignal.aborted) abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => { if (timer) clearTimeout(timer); parentSignal?.removeEventListener?.("abort", abort); },
  };
}

function safeContext(context) {
  const value = context && typeof context === "object" ? context : {};
  const out = {};
  const keys = ["identity", "goal", "strategy", "preferences", "constraints", "corrections", "evidence", "activeRoles"];
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string") out[key] = item.slice(0, 500);
    else if (Array.isArray(item)) out[key] = item.filter(x => typeof x === "string").slice(0, 6).map(x => x.slice(0, 300));
  }
  return out;
}

function contextMessages(aibodyContext) {
  const context = safeContext(aibodyContext);
  if (!Object.keys(context).length) return [];
  return [{ role: "user", content: `安全共享上下文（仅供本次分析）：${JSON.stringify(context)}` }];
}

function emit(onEvent, type, data) {
  try {
    if (typeof onEvent !== "function") return;
    const result = onEvent(type, data);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch { /* observers cannot break execution */ }
}

export const ASK_USER_TOOL = Object.freeze({
  type: "function",
  function: {
    name: "ask_user",
    description: "遇到只有伙伴能定的取舍（方向、范围、口味）时调用：停下来，把问题和 2-6 个选项交给主代理转给伙伴。能自己查清的不要问。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "一句话问题" },
        options: { type: "array", items: { type: "string" }, description: "2-6 个短选项" },
      },
      required: ["question", "options"],
    },
  },
});
const ASK_USER_NOTE = "\n真遇到只有伙伴能定的取舍，调用 ask_user 停下来问（会转成选项卡给伙伴点）；能自己查清的不要问。";

export function parseAskUser(raw) {
  let args = {};
  try { args = JSON.parse(raw || "{}"); } catch { /* 坏参数按空处理 */ }
  const question = String(args.question || "").trim().slice(0, 200) || "需要你拍板";
  const options = [...new Set((Array.isArray(args.options) ? args.options : []).map(o => String(o?.label ?? o ?? "").trim().slice(0, 60)).filter(Boolean))].slice(0, 6);
  return { question, options };
}

export function initSubagent(options = {}) {
  const { httpFetch, authReader, modelReader, resolveAuth, getDefaultModel, getFlashModel, traceDir, researchRoots, webSearch } = options;
  _researchRoots = researchRoots || null;
  _research = (typeof researchRoots === 'function' || (Array.isArray(researchRoots) && researchRoots.length)) ? createResearchExecutor({ roots: researchRoots, webSearch }) : null;
  _adapterOptions = { httpFetch, authReader, modelReader, resolveAuth };
  _adapter = new HttpModelAdapter(_adapterOptions);
  if (getDefaultModel) _getDefaultModel = getDefaultModel;
  if (getFlashModel) _getFlashModel = getFlashModel;
  _traceStore = configureSubagentTraces(traceDir || "");
  _ordinal = 0;
}

export async function spawnSubagent({
  task,
  context = [],
  seed = [],
  model,
  timeoutMs = 120000,
  role = "analyst",
  sessionId = "",
  runId = "",
  signal,
  onEvent,
  aibodyContext,
  profile = 'analysis',
  outputFormat = 'json',
  reasoningEffort,
  // 天团成员身份：teamId 决定看板归属，member 用于看板 owner 与审计（profile:'team' 时才生效）。
  teamId = '',
  member = '',
  wsRoot = '',
  // 嵌套深度闸门。研究员的工具表里没有任何 delegate_*，派生不出下一层；
  // 闸门保留是为了将来扩工具时不会绕过上限，以及让 depth 在 trace 里可见。
  parentDepth = 0,
  maxDepth = DEFAULT_MAX_DEPTH,
  // 2026-11-17 可续：resume = 上次存档的进度（接在任务后面）；onCheckpoint 每轮工具后回调一次；
  // askUser = 允许研究员调 ask_user 停下来等人拍板（只给后台子代理，同步派没有地方等人）。
  resume = [],
  onCheckpoint = null,
  askUser = false,
} = {}) {
  const normalizedRole = safeRole(role);
  const m = model || _getFlashModel() || _getDefaultModel();
  const subagentRunId = makeId("subagent");
  const ordinal = ++_ordinal;
  const gate = nextSubagentDepth(parentDepth, { maxDepth });
  const teamMember = String(member || normalizedRole || "member").slice(0, 60);
  const teamBoardId = String(teamId || "").trim().slice(0, 100);
  const policy = resolveToolPolicy(profile, { outputFormat, readTools: !!_research, board: !!teamBoardId });
  const longForm = policy.longForm;
  const memberCtx = policy.kind === "team"
    ? { read: _research, wsRoot: String(wsRoot || "").trim(), teamId: teamBoardId, member: teamMember,
        sessionId, parentRunId: runId, subagentRunId, auditRoot: resolveAuditRoot(wsRoot) }
    : null;
  const common = { runId: subagentRunId, parentRunId: runId, sessionId, role: normalizedRole, task, model: m, attempt: 1, turn: 1, ordinal, depth: gate.depth };
  const started = await _traceStore.begin(common);
  rememberInMemoryTrace(started);
  emit(onEvent, "subagent_started", { ...started, id: subagentRunId, agent: normalizedRole, result: "", evidence: [] });
  const finish = async (patch) => {
    const record = await _traceStore.finish(subagentRunId, patch);
    rememberInMemoryTrace(record);
    emit(onEvent, "subagent_finished", { ...record, id: subagentRunId, agent: normalizedRole, summary: record.result });
    return record;
  };
  if (signal?.aborted) {
    await finish({ status: "cancelled", error: "父任务已取消" });
    return { done: false, error: "子任务已取消", cancelled: true, model: m, subagentRunId };
  }
  // 深度闸门：超限直接失败并留痕，不派发（与 dsh 的 maxDepth 同向）
  if (!gate.allowed) {
    const record = await finish({ status: "failed", error: gate.reason });
    return { done: false, error: record.error, model: m, subagentRunId, depth: gate.depth };
  }
  if (!m || !_adapterOptions) {
    const record = await finish({ status: "failed", error: "subagent 未初始化或无可用模型" });
    return { done: false, error: record.error, model: m, subagentRunId };
  }
  const combined = combineSignal(signal, timeoutMs);
  const baseFetch = _adapterOptions.httpFetch;
  const wrappedFetch = async (url, options = {}) => {
    // The shared adapter retries generic network errors once; mark cancellation as
    // timeout-like internally so an already-cancelled parent never sleeps/retries.
    if (combined.signal.aborted) throw abortError("timeout");
    const request = (baseFetch || globalThis.fetch)(url, { ...options, signal: combined.signal });
    return Promise.race([
      request,
      new Promise((_, reject) => combined.signal.addEventListener("abort", () => reject(abortError("timeout")), { once: true })),
    ]);
  };
  const adapter = new HttpModelAdapter({ ..._adapterOptions, httpFetch: wrappedFetch });
  const useTools = policy.kind !== "none";
  let diagnostics = {};
  try {
    const explicitMessages = explicitSubagentInput({ task, context, seed, longForm });
    const modelDefinition = { ...m, ...(_adapterOptions.modelReader?.()?.[m.provider]?.models || []).find(item => item.id === m.id) };
    const ENVELOPE = "输出必须严格为 JSON 对象（不要输出任何其他文字）：\n" +
      "{\"result\": \"完整任务正文（字符串）\", \"evidence\": [\"关键证据1\", \"关键证据2\"], \"confidence\": 0到1的数字}";
    const SYSTEM = policy.kind === "research"
      ? "你是只读研究员。只完成交给你的这一个子问题，不扩展、不闲聊。\n" +
        `你可以用 read / list / grep / web_search 自己找证据（最多 ${RESEARCH_MAX_STEPS} 轮工具调用，同一轮可以并行调用多个）。` +
        "你不能写文件、不能运行命令、不能看图片；需要这些就在结论里说明，交给主代理。\n" +
        "证据要具体：文件路径:行号、命令无法替代的原文片段、链接。查不到就如实写查不到，不要猜。\n" +
        "查完后直接给最终答案，" + ENVELOPE
      : policy.kind === "team"
      ? [
          `你是天团成员「${teamMember}」，只完成分派给你的这一个阶段，不扩展、不重写整份交付（写完整交付的阶段除外）。`,
          `你能用的工具只有：${policy.toolNames.join(" / ")}。`,
          policy.toolNames.includes(TEAM_MEMBER_BOARD_TOOL)
            ? "看板纪律（必须照做）：① 开工前先调用 team_board（action:\"list\", ready:true）找到属于你的任务——subject 里带你的成员名的就是你的；② claim 必须带 expectedRevision（list 返回的 rev），不带会被拒绝；③ 做完立刻 complete 并写 result；④ 卡住或做不了就 release，别占着坑。不能 create 新任务（任务由主控预建）。"
            : "",
          `工具预算：最多 ${policy.maxSteps} 轮工具调用、合计 ${policy.maxToolCalls} 次；到上限会被强制收尾，请提前留出写正文的时间。`,
          "你不能写文件、运行命令、生成图片或视频、也不能再派子代理；需要这些就在正文里说明，交给主代理。",
          "证据要具体：文件路径:行号、原文片段、链接。查不到就如实写查不到，不要猜。",
          outputFormat === 'text' ? '查完后直接给最终结果：按分派要求的结构或正文输出，不输出隐藏思考。' : '查完后直接给最终答案，' + ENVELOPE,
        ].filter(Boolean).join("\n")
      : "你是一个专精单任务的小助手。只完成交给你的任务，不要扩展、不要闲聊。\n" +
        "你只有文本分析能力，不联网、不读文件、不看图片，不得声称已检索、写文件、运行命令或生成真实产物。材料不足时明确指出缺口，请主代理补充。\n" +
        (outputFormat === 'text' ? '直接输出要求的正文，不输出隐藏思考。' : ENVELOPE);
    let messages = [
      { role: "system", content: SYSTEM + (askUser && policy.kind === "research" ? ASK_USER_NOTE : "") },
      ...contextMessages(aibodyContext),
      // fork 型：先给继承来的父对话前缀（真实消息，不是短字符串摘要），
      // 再给 context（显式补充的最小事实），最后才是本轮子任务。
      ...explicitMessages,
    ];
    const baseLength = messages.length;
    if (Array.isArray(resume) && resume.length) messages = [...messages, ...resume];
    const checkpoint = (msgs) => {
      if (typeof onCheckpoint !== "function") return;
      try { onCheckpoint(msgs.slice(baseLength)); } catch { /* 存档失败不影响干活 */ }
    };
    const tools = askUser && policy.kind === "research" ? [...policy.tools, ASK_USER_TOOL] : policy.tools;
    let needsInput = null;
    diagnostics = subagentBudget(modelDefinition, messages, { longForm, reasoningEffort });
    const { outputBudget } = diagnostics;
    const ask = (msgs, tools) => adapter.chat(m, msgs, { params: { temperature: 0.3 }, maxTokens: outputBudget,
      outputCeiling: outputBudget, reasoningEffort: reasoningEffort || 'low', signal: combined.signal, ...(tools ? { tools } : {}) });
    let response;
    let toolCalls = 0;
    let toolRounds = 0;
    if (useTools) {
      // 有界工具循环（research / team 共用）：轮次或总调用数到顶后，最后一轮不给工具，逼它收口出稿。
      for (let step = 0; step <= policy.maxSteps; step++) {
        const remaining = policy.maxToolCalls - toolCalls;
        const finalStep = step >= policy.maxSteps || remaining <= 0;
        if (!finalStep) toolRounds += 1;
        const finalNote = remaining <= 0
          ? `工具调用总预算已用完（${policy.maxToolCalls} 次），不能再调用任何工具。请基于已获得的证据直接给出最终${policy.kind === "team" ? "正文" : " JSON 结论"}。`
          : `工具轮次已用完（${policy.maxSteps} 轮），不能再调用工具。请基于已获得的证据直接给出最终${policy.kind === "team" ? "正文" : " JSON 结论"}。`;
        response = await ask(finalStep ? [...messages, { role: "user", content: finalNote }] : messages, finalStep ? null : tools);
        // 通道不接受 tools 字段时退回纯分析，并在诊断里留痕，不把整次委派判死。
        if (step === 0 && response?.error && /HTTP 4\d\d/.test(response.error) && /tool/i.test(response.error)) {
          diagnostics = { ...diagnostics, errorCode: 'tools_unsupported' };
          response = await ask(messages, null);
          break;
        }
        if (combined.signal.aborted) throw abortError(combined.timedOut() ? "子任务超时" : "子任务已取消");
        if (!response?.toolCalls?.length) break;
        const askCall = response.toolCalls.find(tc => tc.function?.name === ASK_USER_TOOL.function.name);
        if (askCall) {
          // 停下来等人：存档里只留"它问了什么"，不留没回答的调用——续上时直接接答案
          needsInput = parseAskUser(askCall.function.arguments);
          messages = [...messages, { role: "assistant", content: `我需要你拍板：${needsInput.question}（选项：${needsInput.options.join(" / ")}）` }];
          checkpoint(messages);
          break;
        }
        messages = response.history;
        // 同一轮并行调用按剩余总额度截断：超出预算的调用不执行，但都回明确文本（不静默丢）。
        const allowance = Math.max(0, policy.maxToolCalls - toolCalls);
        const results = await Promise.all(response.toolCalls.map(async (tc, index) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* invalid args reported by executor */ }
          let out;
          let executed = true;
          if (policy.kind === "team") {
            const run = await runAuditedTeamMemberTool(tc, args, { ctx: memberCtx, allowExecution: index < allowance, maxToolCalls: policy.maxToolCalls });
            out = run.out; executed = run.executed;
          } else {
            out = await _research(tc.function.name, args);
          }
          emit(onEvent, "subagent_tool", { id: subagentRunId, agent: normalizedRole,
            ...(policy.kind === "team" ? { member: teamMember, teamId: teamBoardId } : {}),
            tool: tc.function.name, target: String(args.path || args.pattern || args.query || args.action || "").slice(0, 120), isError: !!out?.isError });
          return { message: { role: "tool", tool_call_id: tc.id, content: out?.text ?? "" }, executed };
        }));
        toolCalls += results.filter(item => item.executed).length;
        messages = [...messages, ...results.map(item => item.message)];
        checkpoint(messages);
      }
    } else {
      response = await ask(messages, null);
    }
    diagnostics = { ...subagentResponseDiagnostics(response, diagnostics),
      ...(useTools ? { toolCalls, toolRounds, toolLimits: { rounds: policy.maxSteps, calls: policy.maxToolCalls } } : {}) };
    if (combined.signal.aborted) throw abortError(combined.timedOut() ? "子任务超时" : "子任务已取消");
    combined.dispose();
    if (response?.aborted) throw abortError("子任务已取消");
    if (needsInput) {
      const result = `需要你拍板：${needsInput.question}`;
      await finish({ status: "completed", result, evidence: [], confidence: 0.5, diagnostics });
      return { done: true, result, evidence: [], confidence: 0.5, needsInput, model: m, subagentRunId, diagnostics };
    }
    const parsed = parseSubagentResult(response, { outputFormat, maxChars: longForm ? 24000 : 8000, outputBudget });
    const result = parsed.result;
    const evidence = safeEvidence(parsed.evidence);
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    await finish({ status: "completed", result, evidence, confidence, diagnostics });
    return { done: true, result, evidence, confidence, model: m, subagentRunId, diagnostics };
  } catch (error) {
    combined.dispose();
    const timedOut = combined.timedOut();
    const cancelled = signal?.aborted || (error?.name === "AbortError" && !timedOut);
    const message = cancelled ? "子任务已取消" : timedOut ? "子任务超时" : String(error?.message || error).slice(0, 800);
    const errorCode = cancelled ? 'cancelled' : timedOut ? 'timeout' : error?.code || 'upstream_error';
    diagnostics = { ...diagnostics, errorCode };
    const record = await finish({ status: cancelled ? "cancelled" : "failed", error: message, diagnostics });
    return { done: false, error: record.error, errorCode, cancelled, model: m, subagentRunId, diagnostics: record.diagnostics };
  }
}

export async function getSubagentHistory({ sessionId, runId, limit = 50, traceDir } = {}) {
  // Reuse the initialized store when callers ask for its own directory. This
  // avoids two recovery passes racing to rewrite the same orphan record.
  if (traceDir && _traceStore?.traceDir === path.resolve(String(traceDir))) {
    return _traceStore.history({ sessionId, runId, limit });
  }
  if (traceDir) return readSubagentHistory({ sessionId, runId, limit, traceDir });
  const rows = await _traceStore.history({ sessionId, runId, limit });
  return rows.length ? rows : historyFromMemory({ sessionId, runId, limit });
}

export { safeContext };
