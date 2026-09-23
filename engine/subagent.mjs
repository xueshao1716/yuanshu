// 隔离子任务执行器：一次分析调用 + 可追溯生命周期台账。
// 子代理仍不是工具执行器；它只返回结构化分析结论，不写文件、不跑命令。
import { HttpModelAdapter } from "./model-adapter.mjs";
import { nextSubagentDepth, DEFAULT_MAX_DEPTH } from "./subagent-depth.mjs";
import path from "node:path";
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
  const { httpFetch, authReader, modelReader, resolveAuth, getDefaultModel, getFlashModel, traceDir } = options;
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
  // 嵌套深度闸门。**注意：元枢的子智能体目前没有任何工具**（见下面 SYSTEM），
  // 所以它派生不出下一层，这道闸门在今天是空转的——保留它是为了 fork 型子智能体
  // 将来拿到工具时不会绕过上限，以及让 depth 在 trace 里可见。
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
  const outputBudget = longForm ? (['medium', 'high'].includes(reasoningEffort) ? 12000 : 7000) : 2000;
  const SYSTEM = "你是一个专精单任务的小助手。只完成交给你的任务，不要扩展、不要闲聊。\n" +
    "你只有分析能力，不得声称已经写文件、运行命令或生成了真实产物。\n" +
    (outputFormat === 'text' ? '直接输出要求的正文，不输出隐藏思考。' :
      "输出必须严格为 JSON 对象（不要输出任何其他文字）：\n" +
      "{\"result\": \"完整任务正文（字符串）\", \"evidence\": [\"关键证据1\", \"关键证据2\"], \"confidence\": 0到1的数字}");
  const messages = [
    { role: "system", content: SYSTEM },
    ...contextMessages(aibodyContext),
    // fork 型：先给继承来的父对话前缀（真实消息，不是短字符串摘要），
    // 再给 context（显式补充的最小事实），最后才是本轮子任务。
    ...(Array.isArray(seed) ? seed.filter((s) => s && (s.role === "user" || s.role === "assistant") && String(s.content || "").trim()).slice(0, 24).map((s) => ({ role: s.role, content: String(s.content) })) : []),
    ...(Array.isArray(context) ? context.map(c => ({ role: "user", content: String(c).slice(0, 600) })).slice(0, 8) : []),
    { role: "user", content: String(task || "").slice(0, longForm ? 24000 : 1000) },
  ];
  try {
    const response = await adapter.chat(m, messages, { params: { temperature: 0.3 }, maxTokens: outputBudget,
      outputCeiling: outputBudget, ...(longForm ? { reasoningEffort: reasoningEffort || 'low' } : {}), signal: combined.signal });
    if (combined.signal.aborted) throw abortError(combined.timedOut() ? "子任务超时" : "子任务已取消");
    combined.dispose();
    if (response?.aborted) throw abortError("子任务已取消");
    if (response?.finishReason === 'length') throw new Error('子任务输出预算耗尽，未把空正文或截断正文当作完整交付');
    if (response?.error || !response?.text) {
      const record = await finish({ status: "failed", error: response?.error || "无回复" });
      return { done: false, error: record.error, model: m, subagentRunId };
    }
    let parsed = null;
    if (outputFormat === 'text') parsed = { result: response.text, evidence: [], confidence: 0 };
    try {
      const match = String(response.text).match(/\{[\s\S]*\}/);
      if (match && outputFormat !== 'text') parsed = JSON.parse(match[0]);
    } catch { /* handled below */ }
    if (!parsed || typeof parsed.result !== 'string' || !parsed.result.trim()) {
      const record = await finish({ status: "failed", error: "输出不是预期 JSON 结构", result: String(response.text).slice(0, 300) });
      return { done: false, error: record.error, raw: record.result, model: m, subagentRunId };
    }
    if (longForm && parsed.result.length > 24000) throw new Error('子任务正文超过长度上限，未截断发布');
    const result = String(parsed.result).slice(0, longForm ? 24000 : 4000);
    const evidence = safeEvidence(parsed.evidence);
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    await finish({ status: "completed", result, evidence, confidence });
    return { done: true, result, evidence, confidence, model: m, subagentRunId };
  } catch (error) {
    combined.dispose();
    const timedOut = combined.timedOut();
    const cancelled = signal?.aborted || (error?.name === "AbortError" && !timedOut);
    const message = cancelled ? "子任务已取消" : timedOut ? "子任务超时" : String(error?.message || error).slice(0, 800);
    await finish({ status: cancelled ? "cancelled" : "failed", error: message });
    return { done: false, error: message, cancelled, model: m, subagentRunId };
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
