// 隔离子任务执行器：可追溯生命周期台账 + 两种画像。
//   analysis：一次纯文本分析调用（天团/补全/调试接口沿用）。
//   research：只读研究员——有界工具循环（read/list/grep/web_search，见 subagent-research.mjs），
//             不写文件、不跑命令；delegate_task / delegate_fork 走这一种。
import { HttpModelAdapter } from "./model-adapter.mjs";
import { RESEARCH_TOOLS, RESEARCH_MAX_STEPS, createResearchExecutor } from "./subagent-research.mjs";
import { nextSubagentDepth, DEFAULT_MAX_DEPTH } from "./subagent-depth.mjs";
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

export function initSubagent(options = {}) {
  const { httpFetch, authReader, modelReader, resolveAuth, getDefaultModel, getFlashModel, traceDir, researchRoots, webSearch } = options;
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
  // 嵌套深度闸门。研究员的工具表里没有任何 delegate_*，派生不出下一层；
  // 闸门保留是为了将来扩工具时不会绕过上限，以及让 depth 在 trace 里可见。
  parentDepth = 0,
  maxDepth = DEFAULT_MAX_DEPTH,
} = {}) {
  const normalizedRole = safeRole(role);
  const m = model || _getFlashModel() || _getDefaultModel();
  const subagentRunId = makeId("subagent");
  const ordinal = ++_ordinal;
  const gate = nextSubagentDepth(parentDepth, { maxDepth });
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
  const longForm = profile === 'team';
  const research = profile === 'research' && outputFormat === 'json' && _research ? _research : null;
  let diagnostics = {};
  try {
    const explicitMessages = explicitSubagentInput({ task, context, seed, longForm });
    const modelDefinition = { ...m, ...(_adapterOptions.modelReader?.()?.[m.provider]?.models || []).find(item => item.id === m.id) };
    const ENVELOPE = "输出必须严格为 JSON 对象（不要输出任何其他文字）：\n" +
      "{\"result\": \"完整任务正文（字符串）\", \"evidence\": [\"关键证据1\", \"关键证据2\"], \"confidence\": 0到1的数字}";
    const SYSTEM = research
      ? "你是只读研究员。只完成交给你的这一个子问题，不扩展、不闲聊。\n" +
        `你可以用 read / list / grep / web_search 自己找证据（最多 ${RESEARCH_MAX_STEPS} 轮工具调用，同一轮可以并行调用多个）。` +
        "你不能写文件、不能运行命令、不能看图片；需要这些就在结论里说明，交给主代理。\n" +
        "证据要具体：文件路径:行号、命令无法替代的原文片段、链接。查不到就如实写查不到，不要猜。\n" +
        "查完后直接给最终答案，" + ENVELOPE
      : "你是一个专精单任务的小助手。只完成交给你的任务，不要扩展、不要闲聊。\n" +
        "你只有文本分析能力，不联网、不读文件、不看图片，不得声称已检索、写文件、运行命令或生成真实产物。材料不足时明确指出缺口，请主代理补充。\n" +
        (outputFormat === 'text' ? '直接输出要求的正文，不输出隐藏思考。' : ENVELOPE);
    let messages = [
      { role: "system", content: SYSTEM },
      ...contextMessages(aibodyContext),
      // fork 型：先给继承来的父对话前缀（真实消息，不是短字符串摘要），
      // 再给 context（显式补充的最小事实），最后才是本轮子任务。
      ...explicitMessages,
    ];
    diagnostics = subagentBudget(modelDefinition, messages, { longForm, reasoningEffort });
    const { outputBudget } = diagnostics;
    const ask = (msgs, tools) => adapter.chat(m, msgs, { params: { temperature: 0.3 }, maxTokens: outputBudget,
      outputCeiling: outputBudget, reasoningEffort: reasoningEffort || 'low', signal: combined.signal, ...(tools ? { tools } : {}) });
    let response;
    let toolCalls = 0;
    if (research) {
      // 有界工具循环：最多 RESEARCH_MAX_STEPS 轮工具；最后一轮不给工具，逼它收口给结论。
      for (let step = 0; step <= RESEARCH_MAX_STEPS; step++) {
        const finalStep = step === RESEARCH_MAX_STEPS;
        response = await ask(finalStep ? [...messages, { role: "user", content: "工具轮次已用完，请基于已获得的证据直接给出最终 JSON 结论。" }] : messages, finalStep ? null : RESEARCH_TOOLS);
        // 通道不接受 tools 字段时退回纯分析，并在诊断里留痕，不把整次委派判死。
        if (step === 0 && response?.error && /HTTP 4\d\d/.test(response.error) && /tool/i.test(response.error)) {
          diagnostics = { ...diagnostics, errorCode: 'tools_unsupported' };
          response = await ask(messages, null);
          break;
        }
        if (combined.signal.aborted) throw abortError(combined.timedOut() ? "子任务超时" : "子任务已取消");
        if (!response?.toolCalls?.length) break;
        messages = response.history;
        const results = await Promise.all(response.toolCalls.map(async (tc) => {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* invalid args reported by executor */ }
          const out = await research(tc.function.name, args);
          emit(onEvent, "subagent_tool", { id: subagentRunId, agent: normalizedRole, tool: tc.function.name, target: String(args.path || args.pattern || args.query || "").slice(0, 120), isError: !!out.isError });
          return { role: "tool", tool_call_id: tc.id, content: out.text };
        }));
        toolCalls += results.length;
        messages = [...messages, ...results];
      }
    } else {
      response = await ask(messages, null);
    }
    diagnostics = { ...subagentResponseDiagnostics(response, diagnostics), ...(research ? { toolCalls } : {}) };
    if (combined.signal.aborted) throw abortError(combined.timedOut() ? "子任务超时" : "子任务已取消");
    combined.dispose();
    if (response?.aborted) throw abortError("子任务已取消");
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
