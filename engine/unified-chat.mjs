// engine/unified-chat.mjs —— 统一对话通道（2026-08-20 从 server.mjs 拆出）
// unifiedChat/handleUnifiedChat：对话 + 工具循环 + 思考 + 媒体 + 压缩 + 重试 + 任务进度
// 依赖注入：initUnifiedChat({ executeUnifiedTool, findKeyByEntry, readJsonFile, getModelList, getDefaultModel, authPath, modelsPath, cwd })
import { modelEndpoint } from './model-endpoints.mjs';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { json, readBody } from "./http-utils.mjs";
import { markModelBlocked, isAuthErrorStatus, pickFallbackDefault, pickFallbackExcluding, routeProCandidate, routeForAuto } from "./model-router.mjs";
import { classifyAnomaly, recordReply, lastAssistantReply } from "./output-guard.mjs";
import { clampOutputTokens, escalateOutputTokens, maxTokensFieldOf, OUTPUT_TOKEN_FALLBACK } from "./output-budget.mjs";
import { budgetWithinWindow, estimateHistoryTokens } from "./context-headroom.mjs";
import { continuationLimits, truncationRecoveryPrompt, toolTurnLimitResult } from "./task-continuation.mjs";
import { shrinkToolResult, NEEDS_PRO_RE, scavengeToolCalls, projectToolResult } from "./reasonix-tools.mjs";
import { normalizeToolArgs } from "./tool-args.mjs";
import { extractMessages, extractText, attachmentLines } from "./session-utils.mjs";
import { createSseWriter } from "./sse.mjs";
import { httpJsonFetch, httpRawFetch, sessionAffinityHeaders, describeHttpError } from "./http.mjs";
import { PRODUCT_VERSION } from "./version.mjs";
import { createGateway } from "./gateway.mjs";
import { CodeRuntime } from "../code-mode/code-runtime.mjs";
import { createCodeMode } from "../code-mode/code-mode.mjs";
import { detectMediaIntents, extractMediaPrompt, generateMediaAsync, mediaAwarePrompt, explainMediaError, assistantContentWithMedia, isPureImageRequest } from "./media-api.mjs";
import { explicitToolMedia, mediaDeliveryKey } from "./media-embed.mjs";
import { readOpenAIChatStream } from "./openai-stream.mjs";
import { buildMessagesRequest, messagesEndpoint, messagesHeaders } from "./anthropic-messages.mjs";
import { readMessagesStream } from "./anthropic-stream.mjs";
import { saveArtifact } from "./workspace-api.mjs";
import { directChat, maybeCompactHistory, needsMidLoopCompact } from "./model-client.mjs";
import { bindTodoSession, formatTodoPrompt } from "./yuanshu-todo.mjs";
import { readEntriesFromFile } from "./session-files.mjs";
import { loadProjectRules, loadMemory, shouldInjectFullMemory, setLastUserQuery, loadSkillIndex, loadExperienceIndex } from "./context-loader.mjs";
import { compactKeepArchive } from "./yuanshu-compact.mjs";
import { prependAssembledSystem } from "./yuanshu-prompt.mjs";
import { assembleYuanshuSystem, registerPromptSection, promptTimeText, promptPersonaText } from "./yuanshu-seams.mjs";
import { bindWorkmemSession, formatPlanPrompt } from "./yuanshu-workmem.mjs";
import { persistYuanshuUser, persistYuanshuAssistant, persistYuanshuToolTrace, resumePersistenceState, abortedAssistantText } from "./yuanshu-session.mjs";
import { beginYuanshuEmotion, endYuanshuEmotion, lastTalkAt } from "./yuanshu-emotion.mjs";
import { readActivityRhythm } from "./activity-rhythm.mjs";
import { pendingPromiseText } from "./promises.mjs";
import { goalPrompt } from "./goals.mjs";
import { effectiveSandboxMode } from "./sandbox-session.mjs";
import { resolveAuth } from "./dsh-keys.mjs";
import { runYuanshuToolRound, attachYuanshuCodeTool, toolCallLoopKey } from "./yuanshu-loop.mjs";
import { restorePendingToolPlan } from "./resume-tool-plan.mjs";
import { canonicalStepKey, hashArgs } from "./run-effects.mjs";
import {
  EMPTY_TURN_ERROR,
  TRUNCATED_TOOL_ERROR,
  isEmptyAssistantTurn,
  emptyTurnDecision,
  inspectToolCalls,
} from "./yuanshu-stability.mjs";
export { toolCallLoopKey };

let _executeUnifiedTool = null, _findKeyByEntry = null, _readJsonFile = null, _getModelList = () => [], _getDefaultModel = () => null, _authPath = "", _modelsPath = "", _cwd = "", _sessionDir = "", _piPackage = "", _unifiedTools = [], _getAgentDir = null, _createSandboxAsk = null, _THINK_TOOL = null;
export function initUnifiedChat({ executeUnifiedTool = null, findKeyByEntry = null, readJsonFile = null, getModelList = null, getDefaultModel = null, authPath = "", modelsPath = "", cwd = "", sessionDir = "", piPackage = "", UNIFIED_TOOLS = [], getAgentDir = null, createSandboxAsk = null, THINK_TOOL = null } = {}) {
  _executeUnifiedTool = executeUnifiedTool; _findKeyByEntry = findKeyByEntry; _readJsonFile = readJsonFile;
  if (getModelList) _getModelList = getModelList; if (getDefaultModel) _getDefaultModel = getDefaultModel;
  _authPath = authPath; _modelsPath = modelsPath; _cwd = cwd; _sessionDir = sessionDir; _piPackage = piPackage; _unifiedTools = UNIFIED_TOOLS;
  if (getAgentDir) _getAgentDir = getAgentDir;
  _createSandboxAsk = createSandboxAsk;
  if (THINK_TOOL) _THINK_TOOL = THINK_TOOL;
}
// ══ 工具调用消毒（2026-08-22 修复 400 "`function` is not set"）：
// 上游返回的 tool_calls 可能缺 function 字段（流式截断/非标准格式），原样回传给 API 会 400，
// 且坏消息留在历史里每轮重发 → 会话永久卡死。策略：能修补则修补（空 name 丢弃），缺 function 的条目剔除。
export function sanitizeToolCallList(tcs) {
  if (!Array.isArray(tcs)) return tcs;
  return tcs
    .map(tc => {
      if (!tc || typeof tc !== "object") return null;
      if (!tc.id || !tc.function || typeof tc.function !== "object") return null;
      if (!tc.function.name) return null;
      // 2026-09-16：arguments 必须能 parse 成**对象**。历史上出现过双重编码
      // （字符串里再套一层 JSON 字符串），上游直接 400 把整轮打死 —— 见 engine/tool-args.mjs。
      return { id: tc.id, type: "function", function: { name: tc.function.name, arguments: normalizeToolArgs(tc.function.arguments) } };
    })
    .filter(Boolean);
}
export function sanitizeToolCalls(messages) {
  if (!Array.isArray(messages)) return messages;
  const out = [];
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      const fixed = sanitizeToolCallList(m.tool_calls);
      if (fixed.length !== m.tool_calls.length) {
        // 有坏条目：剔除坏条目后，若一条不剩则降级为纯文本消息（避免悬空的 tool 结果配对错误）
        if (!fixed.length) { out.push({ role: "assistant", content: m.content ?? "" }); continue; }
        out.push({ ...m, tool_calls: fixed });
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

// ══ 中转脏参数修复（2026-08-31，wawazz 实测）：部分中转做 anthropic→openai 流式拼接时，
// arguments 会拼出 '{}{"path":...}' 这类空对象前缀 → JSON.parse 失败 → 工具拿到空参数。
// 策略：仅当整串 parse 失败且存在 "{}" 前缀时剥离（正常 JSON 不动）。
export function repairToolArgs(s) {
  if (typeof s !== "string" || !s) return s;
  try { JSON.parse(s); return s; } catch {}
  let out = s;
  while (/^\{\s*\}\s*(?=\{)/.test(out)) out = out.replace(/^\{\s*\}\s*/, "");
  try { JSON.parse(out); return out; } catch { return s; }
}

// ══ 工具开关判定（2026-08-31 抽出）：
// - compat.supportsTools:false → 一律不传 tools
// Native Messages and OpenAI both support tools; explicit capability overrides win.
export function modelAllowsTools(mdef) {
  if (mdef?.compat?.supportsTools === false) return false;
  return true;
}

// 出图旁路已在跑时，主模型不必空转 20 轮「自己去调绘图 API」。普通任务仍 20。
export function toolLoopMaxTurns(opts = {}) {
  const n = Number(opts.maxTurns);
  if (Number.isFinite(n) && n > 0) return Math.min(Math.max(1, Math.floor(n)), 20);
  if (opts.imageIntent) return 6;
  if (opts.videoIntent) return 20;
  return 20;
}

export function splitAssistantPayload(msg) {
  const content = String(msg?.content || "").trim();
  let think = String(msg?.reasoning_content || "").trim();
  let text = content;
  if (/<think>[\s\S]*?<\/think>/.test(content)) {
    const m = content.match(/<think>([\s\S]*?)<\/think>/);
    if (!think) think = String(m?.[1] || "").trim();
    text = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
  }
  return { think, text };
}

export function lastPartialAssistantText(history) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== "assistant") continue;
    const { text } = splitAssistantPayload(m);
    if (text) return text;
  }
  return "";
}

// directChat appends the current user message itself. The live unified history
// already contains that message, so remove only the trailing user turn while
// preserving system instructions and tool evidence for a meaningful fallback.
export function fallbackHistoryForDirectChat(history) {
  if (!Array.isArray(history)) return [];
  return history.at(-1)?.role === "user" ? history.slice(0, -1) : [...history];
}

/** 会话起始时间（毫秒）：hist 里最早一条带时间戳的消息。用于"本次会话已持续多久"。 */
export function sessionStartedAt(hist = []) {
  for (const item of Array.isArray(hist) ? hist : []) {
    const ts = item?.ts;
    if (!ts) continue;
    const ms = typeof ts === "number" ? ts : Date.parse(String(ts));
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
}

// Rebuild an OpenAI-compatible history from the compact session projection.
// Keep assistant tool calls paired with their tool results so the next turn
// can continue a long task instead of guessing what already happened.
// projectTool 默认是"前 N 次发全文、之后压缩"，见 reasonix-tools.mjs 的 FULL_SENDS；
// 做成可注入是为了让测试能控制计数状态，而不是共享模块级 Map。
export function formatSessionHistory(hist = [], { projectTool = projectToolResult } = {}) {
  const project = typeof projectTool === "function" ? projectTool : projectToolResult;
  const out = [];
  for (const item of Array.isArray(hist) ? hist : []) {
    if (!item?.role) continue;
    if (item.role === "user") {
      // 附件在盘上是文本标记、在 extractMessages 里已经被剥成 files；这里还原成一行给模型，
      // 顺便修掉"只有附件没有正文"的空用户消息（空 content 在部分上游直接 400）。
      const lines = attachmentLines(item.files);
      const text = [String(item.text || ""), ...lines].filter(s => s && s.trim()).join("\n");
      if (!text) continue;
      out.push({ role: "user", content: text });
      continue;
    }
    if (item.role !== "assistant") continue;
    const text = String(item.text || "");
    const tools = Array.isArray(item.tools) ? item.tools.filter(t => t?.id && t?.name) : [];
    if (!tools.length) {
      if (text) out.push({ role: "assistant", content: text });
      continue;
    }
    out.push({
      role: "assistant",
      content: text || null,
      ...(item.anthropic_content ? { anthropic_content: item.anthropic_content } : {}),
      ...(item.anthropic_model ? { anthropic_model: item.anthropic_model } : {}),
      // 2026-09-16：args 本来就是字符串时，JSON.stringify 会二次编码成 `"{\"…\"}"`，
      // 上游要求 arguments 能 parse 成对象 → 双重编码就 400（真机事故）。统一走 normalizeToolArgs。
      tool_calls: tools.map(t => ({ id: String(t.id), type: "function", function: { name: String(t.name), arguments: normalizeToolArgs(t.args) } })),
    });
    for (const tool of tools) {
      out.push({ role: "tool", tool_call_id: String(tool.id), content: project(tool) });
    }
  }
  return out;
}

const RUN_HISTORY_SNAPSHOT_VERSION = 1;
const RUN_HISTORY_SNAPSHOT_MAX_MESSAGES = 16;
const RUN_HISTORY_SNAPSHOT_MAX_CHARS = 48 * 1024;

function snapshotMessage(message, maxChars) {
  if (!message || typeof message !== "object") return null;
  const out = { role: String(message.role || "") };
  if (!out.role) return null;
  if ("content" in message) {
    if (typeof message.content === "string") out.content = message.content.slice(0, maxChars);
    else if (message.content == null) out.content = message.content;
    else {
      try {
        const value = JSON.parse(JSON.stringify(message.content));
        out.content = Array.isArray(value) ? value.slice(0, 32) : String(JSON.stringify(value)).slice(0, maxChars);
      } catch { out.content = String(message.content).slice(0, maxChars); }
    }
  }
  if (message.tool_call_id) out.tool_call_id = String(message.tool_call_id);
  // Signed native blocks must be copied exactly, never truncated independently.
  if (Array.isArray(message.anthropic_content)) out.anthropic_content = structuredClone(message.anthropic_content);
  if (message.anthropic_model) out.anthropic_model = message.anthropic_model;
  if (Array.isArray(message.tool_calls)) {
    out.tool_calls = message.tool_calls.slice(0, 16).map(call => ({
      id: String(call?.id || ""),
      type: call?.type || "function",
      function: {
        name: String(call?.function?.name || ""),
        arguments: String(call?.function?.arguments || "{}").slice(0, maxChars),
      },
    })).filter(call => call.id && call.function.name);
  }
  return out;
}

export function createRunHistorySnapshot(history, { turn = 0, maxMessages = RUN_HISTORY_SNAPSHOT_MAX_MESSAGES, maxChars = RUN_HISTORY_SNAPSHOT_MAX_CHARS } = {}) {
  const list = Array.isArray(history) ? history.filter(Boolean) : [];
  const limit = Math.max(1, Math.min(64, Number(maxMessages) || RUN_HISTORY_SNAPSHOT_MAX_MESSAGES));
  const systems = list.filter(message => message?.role === "system");
  const tail = list.slice(-limit).filter(message => message?.role !== "system");
  // Pin the current request: tail-only snapshots lose the task after a few
  // tool rounds, which also makes resumed tool-trace persistence skip it.
  const currentUser = list.findLast(message => message?.role === "user");
  const selected = [...systems, ...(currentUser && !tail.includes(currentUser) ? [currentUser] : []), ...tail];
  const pinnedUser = currentUser ? snapshotMessage(currentUser, Math.min(12_000, maxChars)) : null;
  let reserved = pinnedUser ? JSON.stringify(pinnedUser).length : 0;
  let messages = [];
  let size = 0;
  for (const message of selected) {
    const item = snapshotMessage(message, Math.min(12_000, maxChars));
    if (!item) continue;
    const itemSize = JSON.stringify(item).length;
    if (message === currentUser) reserved = 0;
    if (message !== currentUser && size + itemSize + reserved > maxChars) continue;
    messages.push(item);
    size += itemSize;
  }
  // A byte/message boundary must not split a completed tool exchange. Keep
  // genuinely pending plans, but omit completed calls whose result was cut.
  const completedIds = new Set(list.filter(m => m.role === "tool").map(m => m.tool_call_id));
  const resultIds = new Set(messages.filter(m => m.role === "tool").map(m => m.tool_call_id));
  messages = messages.filter(m => !m.tool_calls?.some(call => completedIds.has(call.id) && !resultIds.has(call.id)));
  const callIds = new Set(messages.flatMap(m => m.tool_calls || []).map(call => call.id));
  messages = messages.filter(m => m.role !== "tool" || callIds.has(m.tool_call_id));
  return {
    v: RUN_HISTORY_SNAPSHOT_VERSION,
    turn: Number.isInteger(turn) ? turn : 0,
    messages,
    digest: hashArgs(messages),
  };
}

export function restoreRunHistorySnapshot(snapshot) {
  if (!snapshot || snapshot.v !== RUN_HISTORY_SNAPSHOT_VERSION || !Array.isArray(snapshot.messages)) return null;
  const restored = snapshot.messages.map(message => snapshotMessage(message, 12_000)).filter(Boolean);
  return restored.length ? restored : null;
}

function toolPlanFor(toolCalls, completed = null) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((tc, ordinal) => {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    const final = completed?.[ordinal];
    return {
      id: tc.id,
      name: tc.function?.name || "",
      args,
      argsHash: hashArgs(args),
      ordinal: Number.isInteger(final?.ordinal) ? final.ordinal : Number.isInteger(tc.__ordinal) ? tc.__ordinal : ordinal,
      ...(final?.effectKey ? { effectKey: final.effectKey } : {}),
      status: final?.status || "pending",
      ...(final?.isError !== undefined ? { isError: final.isError === true } : {}),
    };
  });
}

function createRunCheckpointWriter(writer, runContext) {
  return (snapshot = {}) => {
    try {
      const historySnapshot = {
        v: snapshot.v || 1,
        turn: Number.isInteger(snapshot.turn) ? snapshot.turn : 0,
        messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
        digest: snapshot.digest || null,
      };
      const checkpoint = {
        ...snapshot,
        phase: "executing",
        step: snapshot.phase === "tool_results" ? "tool-results" : snapshot.phase === "model_response" ? "model-response" : snapshot.phase === "model_request" ? "model-request" : "tool-plan",
        checkpointKind: snapshot.phase || "checkpoint",
        historySnapshot,
        historyDigest: snapshot.digest || null,
        historyCount: historySnapshot.messages.length,
      };
      runContext?.saveCheckpoint?.(checkpoint);
      writer.push("checkpoint", checkpoint);
    } catch {}
  };
}

function emitRoundStream(opts, msg) {
  const { think, text } = splitAssistantPayload(msg);
  try { if (think && opts?.onThink) opts.onThink(think); } catch {}
  try { if (text && opts?.onDelta) opts.onDelta(text); } catch {}
  return { think, text };
}

export async function unifiedChat(model, messages, opts = {}) {
  opts = { ...opts, executionContext: { ...opts.executionContext, model } };
  const auth = _readJsonFile(_authPath);
  const key = auth[model.provider]?.key;
  if (!key) return { error: `无 ${model.provider} 的 key` };
  const resolved = resolveAuth(model.provider);
  const store = _readJsonFile(_modelsPath);
  const mdef = (store[model.provider]?.models || []).find(m => m.id === model.id)
    || _getModelList().find(m => m.provider === model.provider && m.id === model.id);
  // 2026-09-16：**模型定义里的 baseUrl 优先**。auth.json 那份是账号级的，端点未必相同：
  // 真机上 auth 记的是 zen/v1、模型定义是 zen/go/v1，用 auth 那份直接 401 "Model … is not supported"。
  const baseUrl = mdef?.baseUrl || resolved?.baseUrl || model.baseUrl;
  if (!baseUrl) return { error: "无 baseUrl" };
  const base = (baseUrl || "").replace(/\/+$/, "");
  const baseNoV1 = base.endsWith("/v1") ? base.slice(0, -3) : base;
  const nativeMessages = (mdef?.api || model.api) === "anthropic-messages";
  let history = sanitizeToolCalls([...messages]);
  const restoredHistory = restoreRunHistorySnapshot(opts.resumeSnapshot);
  if (restoredHistory?.length) {
    // Older snapshots did not retain the user request. Repair from the real
    // session context, without replaying its already-completed tool history.
    if (!restoredHistory.some(message => message.role === "user")) {
      const currentUser = history.findLast(message => message.role === "user");
      const firstNonSystem = restoredHistory.findIndex(message => message.role !== "system");
      if (currentUser) restoredHistory.splice(firstNonSystem < 0 ? restoredHistory.length : firstNonSystem, 0, currentUser);
    }
    history = sanitizeToolCalls(restoredHistory);
  }
  // Tools are native to both supported protocols.
  const noTools = !modelAllowsTools(mdef || model);
  // 2026-08-30 修复：无工具模型注入「无工具模式」提示。agent 训练背景的模型（hy4-preview 等）
  // 被要求看文件/跑命令时会编造 <tool_call> 文本幻觉，用户看到假调用却永远等不到结果。
  // 显式告知无工具 + 引导向用户要内容，大幅减少该幻觉。
  if (noTools && !history.some(message => message?.role === "system" && String(message.content || "").includes("【无工具模式】"))) {
    history.unshift({ role: "system", content: "【无工具模式】本次对话你没有工具可用（不能读写文件、执行命令、搜索网页）。不要输出 <tool_call>、<function_call> 等任何形式的工具调用——那只是文本，没有系统会执行它们。若任务需要文件内容或命令输出，请直接请用户粘贴相关内容，再基于内容回答。" });
  }
  const toolDefs = opts.tools === false || noTools ? undefined : (opts.tools || _unifiedTools);
  const maxTurns = toolLoopMaxTurns(opts);
  let streamed = false;
  // 官方理念：按模型声明的 reasoning/compat/thinkingLevelMap 统一适配（不按厂商特判）
  const isReasoning = mdef?.reasoning === true || model.reasoning === true;
  const compat = mdef?.compat || model.compat || {};
  const thinkingLevelMap = mdef?.thinkingLevelMap || model.thinkingLevelMap || null;
  // 思考模型：映射 pi thinking level → provider 参数（默认 high）；不支持时降级
  let thinkingParam = null;
  if (isReasoning && !nativeMessages) {
    const mapped = thinkingLevelMap?.["high"];
    if (mapped !== null && mapped !== false && mapped !== undefined) thinkingParam = mapped;
    else if (compat.supportsReasoningEffort !== false) thinkingParam = "high";
  }
  // 工具表防御性归一化（2026-08-22）：混入扁平格式（pi 自定义工具）或缺 function 的条目会导致上游 400
  const normTools = (defs) => (Array.isArray(defs) ? defs : [])
    .filter(t => t && (t.function?.name || t.name))
    .map(t => t.function ? t : {
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
    });
  const buildBody = (withThinking, wantStream = true) => {
    if (nativeMessages) return buildMessagesRequest({ model: model.id, modelKey: `${model.provider}/${model.id}`, messages: history, tools: toolDefs, maxTokens: outputBudget, stream: wantStream, params: opts.params });
    const body = {
      model: model.id,
      messages: history.map(({ anthropic_content, anthropic_model, ...message }) => message),
      ...(toolDefs ? { tools: normTools(toolDefs), tool_choice: "auto" } : {}),
      stream: wantStream,
    };
    // 单次输出预算（2026-09-16）：以前写死 8192，比模型声明的 32k~384k 低一个数量级，
    // 结果是"一次写完一个大文件"必然被截断 → 守卫报 truncated → 甩锅给用户"请把任务拆小"。
    body[maxTokensFieldOf(compat)] = outputBudget;
    // 模型参数（借鉴 Open WebUI 参数面板）：temperature / top_p 可调
    if (opts.params) {
      if (typeof opts.params.temperature === "number" && opts.params.temperature >= 0 && opts.params.temperature <= 2) body.temperature = opts.params.temperature;
      if (typeof opts.params.top_p === "number" && opts.params.top_p > 0 && opts.params.top_p <= 1) body.top_p = opts.params.top_p;
    }
    if (withThinking && thinkingParam !== null) body.reasoning_effort = thinkingParam;
    return body;
  };
  const mkReq = (u, withThinking, wantStream = true) => httpRawFetch(nativeMessages ? messagesEndpoint(base) : u, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(nativeMessages ? messagesHeaders(key) : { Authorization: `Bearer ${key}` }),
      Accept: "text/event-stream",
      // 会话亲和头：原生通道（opencode-go 等）缺它会 400 MissingSessionID / 认不出模型
      ...sessionAffinityHeaders({ provider: model.provider, compat, sessionId: opts.executionContext?.sessionId || opts.sessionId }),
    },
    body: JSON.stringify(buildBody(withThinking, wantStream)),
    timeout: 300000,
    signal: opts.signal, // P2: 客户端断开时取消 fetch
  });
  let usedThinking = thinkingParam !== null;
  // 单次输出预算：起步 = min(模型声明, 32k)，命中截断时往上抬（见 escalateOutputTokens）。
  // 2026-09-18 补：还要受**剩余窗口**约束——上下文快满时向窗口装不下的量要输出，
  // 上游要么 400，要么提前截断（"说到一半被打断"）。窗口未知时不算，保持原样。
  const historyTokens = estimateHistoryTokens(history);
  let outputBudget = budgetWithinWindow({
    declaredMaxTokens: clampOutputTokens(mdef),
    contextWindow: Number(mdef?.contextWindow) || 0,
    usedTokens: historyTokens,
    fallback: OUTPUT_TOKEN_FALLBACK,
  });
  // A checkpointed snapshot already represents the completed model turns.
  // Continue numbering from it so effect keys remain stable across recovery.
  let turn = Number.isInteger(opts.resumeSnapshot?.turn) ? opts.resumeSnapshot.turn : 0;
  if (opts.resumeCheckpointKind === "model_request") turn = Math.max(0, turn - 1);
  const continuation = continuationLimits(opts, maxTurns, turn);
  let batchLimit = continuation.limit;
  let recentProgress = false;
  let pauseReason = 'tool_turn_limit';
  let continuedText = "";
  let usedModel = null; // provenance：记录实际使用的模型（Auto 路由/降级时前端可见）
  const jitInjected = new Set(); // 本会话 JIT 目录规则已注入集合（每目录一次）
  const seenCalls = new Map();
  const stuckEvents = [];
  let lastCompactTurn = 0;
  let emptyTries = 0;
  // 上游偶发只吐出半截工具 JSON。允许在保留已完成工具结果的前提下
  // 让模型重新组织这一轮，避免一个坏调用把整项长任务直接判死。
  let truncatedToolRetries = 0;
  const MAX_TRUNCATED_TOOL_RETRIES = 2;
  const resumeSandboxAsk = opts.sandboxAsk;
  const maybeCompactMidLoop = async () => {
    if (!needsMidLoopCompact(history, { turn, lastCompactTurn })) return;
    const packed = await compactKeepArchive(history, (h) => maybeCompactHistory(h, model, "", { minMessages: 10, minChars: 20000 }));
    if (packed.compacted) {
      history.length = 0;
      history.push(...packed.view);
      lastCompactTurn = turn;
    }
  };

  // If the process stopped after the provider emitted tool calls but before
  // the round finished, replay only those calls. The effects ledger decides
  // whether each call is reusable or must remain fail-closed.
  const resumeCalls = toolDefs ? restorePendingToolPlan(history, opts.resumeToolPlan) : [];
  if (resumeCalls.length && toolDefs) {
    const resumeTurn = Number.isInteger(opts.resumeSnapshot?.turn) ? opts.resumeSnapshot.turn : turn;
    const resumed = await runYuanshuToolRound({
      toolCalls: resumeCalls,
      history,
      execute: _executeUnifiedTool,
      signal: opts.signal,
      onTool: opts.onTool,
      onToolEnd: opts.onToolEnd,
      seenCalls,
      jitInjected,
      spill: spillIfHuge,
      stuckEvents,
      sandboxMode: opts.sandboxMode,
      sandboxWsRoot: opts.sandboxWsRoot || _cwd,
      sandboxAsk: resumeSandboxAsk,
      effects: opts.effects,
      executionContext: { ...(opts.executionContext || {}), turn: resumeTurn },
    });
    try { opts.onCheckpoint?.({ phase: "tool_results", turn: resumeTurn, toolPlan: toolPlanFor(resumeCalls, resumed.toolPlan), ...createRunHistorySnapshot(history, { turn: resumeTurn }) }); } catch {}
    if (resumed.stop) return resumed.stop;
    turn = resumeTurn;
  }

  while (true) {
    // 客户端已断开 → 立即停止（打断场景：前端 abort 后不再继续消耗模型调用）
    if (opts.signal?.aborted) return { aborted: true, history, text: lastPartialAssistantText(history) };
    if (Date.now() >= continuation.deadline) { pauseReason = 'execution_budget'; break; }
    if (turn >= batchLimit) {
      if (!continuation.automatic) break;
      if (!recentProgress) { pauseReason = 'progress_boundary'; break; }
      batchLimit += maxTurns;
      opts.onNote?.(`本次已完成 ${turn - continuation.startTurn} 轮，工具仍有进展，正在自动接续；剩余自动执行时间约 ${Math.ceil((continuation.deadline - Date.now()) / 60000)} 分钟。`);
    }
    turn++;
    recentProgress = false;
    outputBudget = budgetWithinWindow({ declaredMaxTokens: outputBudget, contextWindow: Number(mdef?.contextWindow) || 0, usedTokens: estimateHistoryTokens(history), fallback: OUTPUT_TOKEN_FALLBACK });
    try { opts.onCheckpoint?.({ phase: "model_request", turn, toolPlan: [], ...createRunHistorySnapshot(history, { turn }) }); } catch {}
    let r;
    let wantStream = true;
    // 自动重试：网络错误/5xx 重试最多 2 次
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        r = await mkReq(modelEndpoint(base, 'chat/completions'), usedThinking, wantStream);
        if (r.status === 404 && !nativeMessages) r = await mkReq(`${baseNoV1}/chat/completions`, usedThinking, wantStream);
        if (!r.ok && r.status >= 500 && attempt === 0) { await new Promise(x => setTimeout(x, 1500)); continue; }
        break;
      } catch (e) {
        if (attempt === 0 && !/timeout/i.test(String(e?.message || ""))) { await new Promise(x => setTimeout(x, 1500)); continue; }
        throw e;
      }
    }
    // 模型不接受 reasoning_effort → 去掉思考参数重试（统一降级，非厂商特判）
    if (!r.ok && usedThinking && (r.status === 400 || r.status === 422)) {
      usedThinking = false;
      r = await mkReq(modelEndpoint(base, 'chat/completions'), false, wantStream);
      if (r.status === 404) r = await mkReq(`${baseNoV1}/chat/completions`, false, wantStream);
    }
    // 个别中转不接受 stream:true → 降级整包 JSON（readOpenAIChatStream 仍能抽出正文）
    if (!r.ok && wantStream && (r.status === 400 || r.status === 422)) {
      wantStream = false;
      r = await mkReq(modelEndpoint(base, 'chat/completions'), usedThinking, false);
      if (r.status === 404 && !nativeMessages) r = await mkReq(`${baseNoV1}/chat/completions`, usedThinking, false);
    }
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      // 健康冷却（2026-08-20 泛化）：401/402/403/429/529 标记 30 分钟，Auto 路由与兜底链自动避开该模型
      if (isAuthErrorStatus(r.status)) markModelBlocked(model, { reason: `HTTP ${r.status} ${String(errBody).slice(0, 60)}` });
      else if (model.provider === "opencode-go" && /GoUsageLimit/i.test(errBody)) markModelBlocked(model, { reason: errBody });
      // 用 describeHttpError：摘出 msg/displayMsg.zh/extError.code，原文留 600 字。
      // 2026-09-16：这里原来只留 150 字，opencode-go 的 RegionError 正好被截在 "requires explicit opt "——
      // 到底要开什么完全看不出来，诊断只能靠猜。
      return { error: `HTTP ${r.status}: ${describeHttpError(errBody)}` };
    }
    usedModel = { provider: model.provider, id: model.id }; // provenance：本轮实际模型
    let roundStreamed = false;
    const parsed = await (nativeMessages ? readMessagesStream : readOpenAIChatStream)(r.body, {
      signal: opts.signal,
      onThink: (t) => { roundStreamed = true; streamed = true; opts.onThink?.(t); },
      onDelta: (t) => { roundStreamed = true; streamed = true; opts.onDelta?.(t); },
      onThinkEnd: () => { opts.onThinkEnd?.(); },
    });
    if (parsed.aborted || opts.signal?.aborted) {
      const streamedText = String(parsed.message?.content || "").trim();
      return { aborted: true, history, text: lastPartialAssistantText(history) || streamedText, streamed };
    }
    if (parsed.error) return { error: parsed.error };
    if (parsed.model) usedModel = { provider: model.provider, id: parsed.model };
    opts.onModel?.(usedModel);
    const msg = parsed.message || {};
    const inspected = inspectToolCalls(msg.tool_calls);
    const lengthLimited = ['length', 'max_tokens'].includes(parsed.finishReason);
    if (inspected.truncated || lengthLimited) {
      // 只丢弃无法解析的调用；同一响应里已经完整的调用仍然执行。
      // 没有完整调用时也不要把半截 JSON 写回 history，否则下一轮请求会再次 400。
      if (truncatedToolRetries >= MAX_TRUNCATED_TOOL_RETRIES) {
        const { text: tail } = splitAssistantPayload(msg);
        if (tail) history.push({ role: 'assistant', content: tail });
        return { error: TRUNCATED_TOOL_ERROR, errorCode: 'output_truncated', history, usedModel,
          text: !msg.tool_calls?.length ? (continuedText + tail) || lastPartialAssistantText(history) : lastPartialAssistantText(history), streamed };
      }
      truncatedToolRetries += 1;
      // 截断多半是"这次要写的东西超过了预算"→ 先把预算抬上去再重试，别急着让用户拆任务
      const bumped = budgetWithinWindow({ declaredMaxTokens: escalateOutputTokens(outputBudget, mdef), contextWindow: Number(mdef?.contextWindow) || 0, usedTokens: estimateHistoryTokens(history), fallback: OUTPUT_TOKEN_FALLBACK });
      if (bumped > outputBudget) {
        console.log(`[元枢] 工具调用被截断 → 单次输出预算 ${outputBudget} → ${bumped} token，重试`);
        outputBudget = bumped;
      }
      const validCalls = toolDefs ? inspected.calls || [] : [];
      if (validCalls.length) {
        if (!roundStreamed) {
          const streamedRound = emitRoundStream(opts, msg);
          if (streamedRound.think || streamedRound.text) streamed = true;
        }
        history.push({ role: "assistant", content: msg.content || null, tool_calls: validCalls,
          ...(msg.anthropic_content ? { anthropic_content: msg.anthropic_content, anthropic_model: `${model.provider}/${model.id}` } : {}),
          ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}) });
        try { opts.onCheckpoint?.({ phase: "tool_plan", turn, toolPlan: toolPlanFor(validCalls), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
        const recovered = await runYuanshuToolRound({
          toolCalls: validCalls, history, execute: _executeUnifiedTool, signal: opts.signal,
          onTool: opts.onTool, onToolEnd: opts.onToolEnd, seenCalls, jitInjected, spill: spillIfHuge,
          stuckEvents, sandboxMode: opts.sandboxMode, sandboxWsRoot: opts.sandboxWsRoot || _cwd,
          sandboxAsk: resumeSandboxAsk, effects: opts.effects,
          executionContext: { ...(opts.executionContext || {}), turn },
        });
        try { opts.onCheckpoint?.({ phase: "tool_results", turn, toolPlan: toolPlanFor(validCalls, recovered.toolPlan), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
        if (recovered.stop) return recovered.stop;
      } else {
        const { think, text } = splitAssistantPayload(msg);
        if (!roundStreamed && (think || text)) {
          const streamedRound = emitRoundStream(opts, msg);
          if (streamedRound.think || streamedRound.text) streamed = true;
        }
        if (text) {
          history.push({ role: "assistant", content: text });
          if (!msg.tool_calls?.length) continuedText += text;
        }
      }
      history.push({
        role: "system",
        content: truncationRecoveryPrompt(outputBudget, truncatedToolRetries),
      });
      opts.onNote?.('检测到输出截断，正在保留已完成步骤并自动分块接续。');
      recentProgress = true;
      await maybeCompactMidLoop();
      // The next loop may pause immediately on its time budget. Save the
      // received fragment AND continuation instruction before that boundary.
      try { opts.onCheckpoint?.({ phase: "model_response", turn, toolPlan: [], ...createRunHistorySnapshot(history, { turn }) }); } catch {}
      continue;
    }
    truncatedToolRetries = 0;
    const tcs = inspected.calls;
    if (tcs && tcs.length && toolDefs) {
      if (!roundStreamed) {
        const streamedRound = emitRoundStream(opts, msg); // 立刻 opts.onThink / opts.onDelta
        if (streamedRound.think || streamedRound.text) streamed = true;
      }
      history.push({ role: "assistant", content: msg.content || null, tool_calls: tcs,
        ...(msg.anthropic_content ? { anthropic_content: msg.anthropic_content, anthropic_model: `${model.provider}/${model.id}` } : {}),
        ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}) });
      try { opts.onCheckpoint?.({ phase: "tool_plan", turn, toolPlan: toolPlanFor(tcs), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
      const official = await runYuanshuToolRound({
        toolCalls: tcs, history, execute: _executeUnifiedTool, signal: opts.signal,
        onTool: opts.onTool, onToolEnd: opts.onToolEnd, seenCalls, jitInjected, spill: spillIfHuge,
        stuckEvents, sandboxMode: opts.sandboxMode, sandboxWsRoot: opts.sandboxWsRoot || _cwd,
        sandboxAsk: opts.sandboxAsk,
        effects: opts.effects,
        executionContext: { ...(opts.executionContext || {}), turn },
      });
      try { opts.onCheckpoint?.({ phase: "tool_results", turn, toolPlan: toolPlanFor(tcs, official.toolPlan), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
      if (official.stop) return official.stop;
      recentProgress = official.toolPlan?.some(item => item.status === 'completed') === true;
      continuedText = "";
      await maybeCompactMidLoop();
      continue;
    }
    // ══ P2 scavenge（Reasonix 借鉴，2026-08-19）：无 tool_calls 但思考里捞到合法工具调用 → 执行（带策略拦截）
    const scavenged = nativeMessages || tcs?.length ? [] : scavengeToolCalls(msg.reasoning_content || "", toolDefs, seenCalls);
    if (scavenged.length) {
      if (!roundStreamed) {
        const streamedRound = emitRoundStream(opts, msg); // 立刻 opts.onThink / opts.onDelta
        if (streamedRound.think || streamedRound.text) streamed = true;
      }
      const scavCalls = scavenged.map(s => ({ id: s.id, type: "function", function: { name: s.name, arguments: JSON.stringify(s.args) } }));
      history.push({ role: "assistant", content: msg.content || null, tool_calls: scavCalls,
        ...(typeof msg.reasoning_content === "string" ? { reasoning_content: msg.reasoning_content } : {}) });
      try { opts.onCheckpoint?.({ phase: "tool_plan", turn, toolPlan: toolPlanFor(scavCalls), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
      const scavengedRound = await runYuanshuToolRound({
        toolCalls: scavCalls, history, execute: _executeUnifiedTool, signal: opts.signal,
        onTool: opts.onTool, onToolEnd: opts.onToolEnd, seenCalls, jitInjected, spill: spillIfHuge,
        stuckEvents, sandboxMode: opts.sandboxMode, sandboxWsRoot: opts.sandboxWsRoot || _cwd,
        sandboxAsk: opts.sandboxAsk,
        effects: opts.effects,
        executionContext: { ...(opts.executionContext || {}), turn },
      });
      try { opts.onCheckpoint?.({ phase: "tool_results", turn, toolPlan: toolPlanFor(scavCalls, scavengedRound.toolPlan), ...createRunHistorySnapshot(history, { turn }) }); } catch {}
      if (scavengedRound.stop) return scavengedRound.stop;
      recentProgress = scavengedRound.toolPlan?.some(item => item.status === 'completed') === true;
      continuedText = "";
      await maybeCompactMidLoop();
      continue;
    }
    const content = String(msg.content || "").trim();
    const { think, text } = splitAssistantPayload(msg);
    if (isEmptyAssistantTurn({ text, hasTools: false })) {
      emptyTries += 1;
      if (emptyTurnDecision(emptyTries) === "retry") {
        turn -= 1;
        continue;
      }
      return { empty: true, think, text: null, history, usedModel, streamed };
    }
    // 诊断：text 空时记录上游响应细节（2026-08-29 临时排查 hy4 空回复）
    if (!text) {
      try {
        const fsdiag = await import("node:fs");
        // M1 路径外部化：调试日志进系统临时目录，不再写死盘符
        fsdiag.appendFileSync(path.join(os.tmpdir(), "yuanshu-unified-debug.log"), JSON.stringify({
          t: new Date().toISOString(), model: model.provider + "/" + model.id, turn,
          content_len: content.length, reasoning_len: think.length,
          tool_calls: Array.isArray(tcs) ? tcs.length : (msg.tool_calls?.length || 0),
          content_head: content.slice(0, 120), reasoning_head: think.slice(0, 120),
        }) + "\n");
      } catch {}
    }
    return { think, text: (continuedText + text) || null, history, usedModel, streamed };
  }
  // 超过轮数上限：尽量返回中间结果（不直接丢错误）。出图旁路已在跑时不要用 20 轮红字盖住图。
  const partial = lastPartialAssistantText(history);
  if (opts.imageIntent) return { text: partial, partial: true, history, usedModel, streamed, truncated: true };
  return toolTurnLimitResult(turn - continuation.startTurn, history, usedModel, streamed, continuedText || partial, pauseReason);
}

// ══ Gateway 2.0：插件化引擎（dsh 设计沉淀——模型/工具/存储/循环全是可替换插件）══
let gateway = null;
let engineInitPromise = null;
let engineInitError = null;
let codeRuntime = null;
let codeMode = null;
const ENGINE_TOOL_NAMES = ["bash", "read", "write", "edit", "web_search"];
// 访问器：codeRuntime/codeMode 是模块私有，server.mjs 路由经此取用
//（修复拆模块遗留：原 server.mjs 裸引用 codeRuntime → ReferenceError）
export function getCodeRuntime() { return codeRuntime; }
export function getCodeMode() { return codeMode; }
export function engineCurrentModel() {
  return { id: _getDefaultModel()?.id || _getModelList()[0]?.id || "", provider: _getDefaultModel()?.provider || _getModelList()[0]?.provider || "", baseUrl: _getDefaultModel()?.baseUrl || _getModelList()[0]?.baseUrl };
}
export async function initEngine() {
  if (gateway) return gateway;
  // Share one in-flight initialization and publish globals only after every
  // core plugin and prompt seam has mounted successfully.
  if (engineInitPromise) return engineInitPromise;
  engineInitPromise = (async () => {
    const nextCodeRuntime = new CodeRuntime({
      bindings: Object.fromEntries(ENGINE_TOOL_NAMES.map((n) => [n, { description: toolBindingDesc(n), args: toolBindingArgs(n), exec: async (args) => _executeUnifiedTool(n, toolBindingArgsObj(n, args)) }])),
    });
    const nextCodeMode = createCodeMode({ runtime: nextCodeRuntime });
    const nextGateway = await createGateway({
      httpFetch: httpJsonFetch,
      authReader: () => _readJsonFile(_authPath),
      modelReader: () => _readJsonFile(_modelsPath),
      resolveAuth: (provider) => resolveAuth(provider),
      defaultExecutor: (name, args) => _executeUnifiedTool(name, args),
      getModel: engineCurrentModel,
      sessionDir: path.join((_getAgentDir ? _getAgentDir() : ""), "engine-sessions"),
    });
    nextGateway.tools.register(nextCodeMode.runCodeToolDef());
    attachYuanshuCodeTool(_unifiedTools, nextCodeMode);
    await registerPromptSection(nextGateway.registry, {
      id: "yuanshu:prompt:time",
      name: "时间上下文",
      section: "time",
      contribute: (ctx) => promptTimeText(ctx?.now, { since: ctx?.since, sessionStart: ctx?.sessionStart, rhythm: ctx?.rhythm }),
    });
    // 待兑现承诺追加到 memory 段（mergeContributedSections 对同 key 是追加而非覆盖）
    await registerPromptSection(nextGateway.registry, {
      id: "yuanshu:prompt:promises",
      name: "待兑现承诺",
      section: "memory",
      contribute: (ctx) => pendingPromiseText(ctx?.cwd, { now: ctx?.now }),
    });
    // 跨轮目标：轮号已由 server.mjs 在分支之前认领，这里只读当前状态，不重复推进
    await registerPromptSection(nextGateway.registry, {
      id: "yuanshu:prompt:goal",
      name: "进行中的目标",
      section: "plan",
      contribute: (ctx) => goalPrompt(ctx?.cwd),
    });
    await registerPromptSection(nextGateway.registry, {
      id: "yuanshu:prompt:persona",
      name: "驱动身份",
      section: "persona",
      contribute: (ctx) => promptPersonaText(ctx?.model),
    });
    await registerPromptSection(nextGateway.registry, {
      id: "yuanshu:prompt:plan",
      name: "磁盘工作记忆",
      section: "plan",
      contribute: (ctx) => formatPlanPrompt(ctx?.sessionId, { message: ctx?.message }),
    });
    codeRuntime = nextCodeRuntime;
    codeMode = nextCodeMode;
    gateway = nextGateway;
    engineInitError = null;
    console.log(`[engine] 元枢就绪：适配器=${gateway.adapter.id} 工具=${gateway.tools.names().join(",")} 存储=${gateway.store.id} 循环=${gateway.loop.id} 接缝=prompt`);
    return gateway;
  })();
  try {
    return await engineInitPromise;
  } catch (error) {
    engineInitError = error;
    throw error;
  } finally {
    engineInitPromise = null;
  }
}
export function toolBindingDesc(name) {
  return { bash: "运行 shell 命令（Windows cmd），如 dir、node、python、git", read: "读取工作空间内文件内容", write: "写入文件（自动创建目录）", edit: "用精确文本替换修改文件（先 read 再 edit）", web_search: "联网搜索（Bing，无需 key）" }[name] || name;
}
export function toolBindingArgs(name) {
  return { bash: "command", read: "path", write: "path, content", edit: "path, oldText, newText", web_search: "query" }[name] || "...";
}
export function toolBindingArgsObj(name, args) {
  // 兼容三种调用形态：
  // ① 位置式 $tools.bash("echo hi") → args=["echo hi"]
  // ② 对象式 $tools.bash({ command }) → args=[{ command }]
  // ③ 宿主直传对象（无 worker 包装）→ args={ command }
  const first = Array.isArray(args) ? args[0] : args;
  if (first !== null && typeof first === "object") {
    if (name === "web_search" && !first.query && first.q) return { ...first, query: first.q };
    return first;
  }
  return { bash: { command: first }, read: { path: first }, write: { path: args?.[0], content: args?.[1] }, edit: { path: args?.[0], oldText: args?.[1], newText: args?.[2] }, web_search: { query: first } }[name] || {};
}

// Keep the call-site explicit: unified chat may continue in a degraded mode,
// while the shared init transaction remains observable and retryable.
async function ensureEngineInit() {
  try {
    await initEngine();
    engineInitError = null;
  } catch (error) {
    engineInitError = error || new Error("engine_init_failed");
    throw engineInitError;
  }
}

// ══ 消息看板：pi 更新 + 能力看板 ══
// 产品版本从唯一来源派生（仓库根 version.json），不再手写常量——
// 手写的那一版实际停在 2.7.1 长达两天，期间发了一整批功能都没动过。
// 发版用 `npm run version:bump <major|minor|patch>`，它会同改所有声明并收 CHANGELOG。
const APP_VERSION = PRODUCT_VERSION;
const CAPABILITIES = [
  { icon: "💬", name: "多模型对话", desc: "deepseek / 小米 mimo / Agnes，思考 + 工具调用" },
  { icon: "🛠", name: "编程工具", desc: "读文件 / 写文件 / 编辑 / 跑命令（与 TUI 同一引擎）" },
  { icon: "🧠", name: "思考块", desc: "reasoning 思考过程内联显示" },
  { icon: "🖼", name: "媒体生成", desc: "配图 / 配音 / 视频，自动落盘到工作空间" },
  { icon: "📦", name: "工作空间", desc: "分类视图（工程/文档/生成物/交付）+ 全屏浏览 + 树状连接线" },
  { icon: "📤", name: "一键交付", desc: "智能文件交付：关键词匹配 + 类型过滤 + 去重，钉钉式文件组" },
  { icon: "📎", name: "文件传输", desc: "断点续传 / 签名下载 / 图片缩略图 / 拖放文件" },
  { icon: "🧠", name: "记忆系统", desc: "固定记忆 + 记忆日志自动沉淀 + 经验库（跨会话长期有效）" },
  { icon: "❤️", name: "情绪引擎", desc: "VAD 三维情绪感知，对话自适应语气与节奏" },
  { icon: "🧬", name: "进化系统", desc: "经验自动归纳加载，越用越懂你的习惯" },
  { icon: "📡", name: "外网分享", desc: "share_project 一键分享，稳定域名 + 自动复制目录" },
  { icon: "🔍", name: "文件搜索", desc: "search_files 按关键词/类型精准定位" },
  { icon: "🌳", name: "会话分支", desc: "分支切换、模板、项目分组、导出" },
  { icon: "🎨", name: "主题系统", desc: "霓虹主题 + 全屏壁纸 + 侧边栏透明" },
  { icon: "👤", name: "人格小语", desc: "直接、有条理、有审美、讨厌机器人味" },
];
// 更新看板缓存：GitHub API 无 token 限流 60 次/时，缓存 6h 缓解 403（限流期不再反复拉取）
const NOTICES_TTL = 6 * 3600 * 1000;
let noticesCache = null;
let noticesCacheAt = 0;
export async function handleNotices(res) {
  let releases;
  const now = Date.now();
  if (noticesCache && now - noticesCacheAt < NOTICES_TTL) {
    releases = noticesCache;
  } else {
    releases = [];
    try {
      const py = `import urllib.request, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
try:
    req = urllib.request.Request("https://api.github.com/repos/earendil-works/pi/releases?per_page=8", headers={"User-Agent":"pi-web","Accept":"application/vnd.github+json"})
    data = json.loads(urllib.request.urlopen(req, timeout=20).read())
    for r in data:
        print(json.dumps({"tag": r.get("tag_name",""), "name": r.get("name",""), "date": (r.get("published_at") or "")[:10], "body": (r.get("body") or "")[:300]}, ensure_ascii=False))
except Exception as e:
    print("ERR:" + str(e))`;
      const out = await new Promise((resolve, reject) => execFile("python", ["-c", py], { timeout: 30000, windowsHide: true, encoding: "utf8" }, (err, stdout) => err ? reject(err) : resolve(stdout)));
      for (const line of out.trim().split("\n").filter(Boolean)) {
        if (line.startsWith("ERR:")) { console.log("[元枢] GitHub 拉取失败:", line.slice(4).slice(0, 60)); continue; }
        try { releases.push(JSON.parse(line)); } catch {}
      }
    } catch {}
    // 失败也缓存（空列表），限流期不反复打 GitHub
    noticesCache = releases;
    noticesCacheAt = now;
    console.log(`[元枢] 更新看板缓存刷新（${releases.length} 条 release，缓存 ${NOTICES_TTL/3600000}h）`);
  }
  let piVersion = "?";
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(_piPackage), "..", "package.json"), "utf8"));
    piVersion = pkg.version || "?";
  } catch {}
  // pi-web 自身更新日志（CHANGELOG.md 最近 5 个版本，每个最多 6 行）
  let changelog = [];
  try {
    const cl = fs.readFileSync(path.join(import.meta.dirname, "..", "CHANGELOG.md"), "utf8");
    const blocks = [...cl.matchAll(/##\s+\[?v?([\d.]+)\]?[^\n]*\n([\s\S]*?)(?=\n##\s|\s*$)/g)];
    changelog = blocks.slice(0, 5).map(b => ({ version: b[1], lines: b[2].trim().split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#")).slice(0, 6) }));
  } catch {}
  json(res, 200, { releases, piVersion, capabilities: CAPABILITIES, appVersion: APP_VERSION, changelog });
}

// SSE 心跳：每 20s 发注释行保持连接活跃（对抗公网隧道/代理的 idle 超时）

// 统一通道：所有模型走 unifiedChat（对话 + 工具 + 思考 + 媒体 + 压缩 + 重试）
export async function handleUnifiedChat(res, entry, message, sessionId, params, signal, writer, thinkOn, taskKey, modelOverride = null, sandboxAskFactory = null, runContext = null) {
  let engineInitError = null;
  try { await ensureEngineInit(); } catch (e) { engineInitError = e || new Error("engine_init_failed"); }
  const taskId = taskKey || sessionId;
  // 复读基准必须在**开跑前**取（2026-09-16 修首轮误判）：本轮回复可能中途就落盘，
  // 事后读文件会拿自己跟自己比 → 全新会话首轮必判复读 → 静默换模型重写。
  const replyBaseline = (() => {
    try { return lastAssistantReply({ sessionFile: entry?.sm?.sessionFile, tree: entry?.sm?.getTree?.() }); } catch { return null; }
  })();
  // 兕底通道用安全模型（opencode-go 429 标记期间避开）；用户显式选中的非原生模型优先（2026-08-29 修复：
  // 之前无论选什么都用 pickFallbackDefault，导致选中 hy4-preview/claude-relay 等被静默换成商汤）
  let chatModel = pickFallbackDefault();
  try {
    const _auth = _readJsonFile(_authPath);
    if (modelOverride && _auth[modelOverride.provider]?.key) chatModel = modelOverride;
    else {
      const auto = routeForAuto(message, sessionId);
      if (auto?.model) chatModel = auto.model;
    }
  } catch {}
  writer = writer || createSseWriter(res);
  const requestedModel = entry.modelKey?.id && entry.modelKey.id !== 'auto' ? { provider: entry.modelKey.provider, id: entry.modelKey.id } : (modelOverride ? { provider: modelOverride.provider, id: modelOverride.id } : null);
  let switchedModel = null;
  const metadataFor = result => ({ model: result?.usedModel, requestedModel, switchedModel, engine: 'yuanshu' });
  try { writer.push("model_selected", { model: { provider: chatModel?.provider, id: chatModel?.id }, requestedModel }); } catch {}
  if (engineInitError) {
    try { writer.push("note", { code: "engine_init_failed", text: `engine_init_failed：引擎初始化失败，本次降级运行（${engineInitError.message}）。` }); } catch {}
  }
  // The server may provide a UI-backed approval seam. Without one, sandbox
  // escalation remains fail-closed and is explicitly observable.
  let approvalAsk = sandboxAskFactory
    ? await sandboxAskFactory({ writer, sessionId, taskId })
    : (_createSandboxAsk ? await _createSandboxAsk({ writer, sessionId, taskId }) : null);
  if (typeof approvalAsk !== "function") approvalAsk = async (name, args, note) => {
    console.log(`[sandbox-approval] 兑底通道升级请求拒绝(fail-closed): ${name} ${JSON.stringify(args || {}).slice(0, 120)} ${note || ""}`);
    return "rejected";
  };
  let collected = "";
  const finishEmotion = () => {
    try { endYuanshuEmotion(sessionId || "new", message, collected, writer); } catch {}
  };
  touchTask(taskId, { stage: "处理中" });
  let hist = [];
  let savedEntries = [];
  try {
    const file = entry.sm.sessionFile;
    if (file && fs.existsSync(file)) {
      savedEntries = readEntriesFromFile(file);
      hist = extractMessages(savedEntries).slice(-20);
    }
  } catch {}
  // Paused replies and tool traces follow the user message. Inspect the full
  // saved turn, not just the last projected message or the last 20 entries.
  const persistedTurn = resumePersistenceState(savedEntries, message, runContext?.resume);
  const persistTrace = history => persistYuanshuToolTrace(entry.sm, history, persistedTurn);
  let userPersisted = persistedTurn.userPersisted;
  const persistUser = () => {
    if (userPersisted) return;
    persistYuanshuUser(entry.sm, message);
    userPersisted = true;
  };
  try { persistUser(); } catch {}
  const mediaIntents = detectMediaIntents(message);
  const imageIntent = mediaIntents.some(i => i.type === "image");
  const videoIntent = mediaIntents.some(i => i.type === "video");
  const skipTools = isPureImageRequest(message);
  const mediaPrompt = extractMediaPrompt(message);
  const runMediaEffect = async (intent, index) => {
    const effectStore = runContext?.effects;
    const runId = runContext?.runId;
    if (!effectStore || !runId) return generateMediaAsync(intent, mediaPrompt);
    const key = canonicalStepKey(`media:${intent.type}`, { intent, prompt: mediaPrompt }, { turn: 0, index });
    const reservation = effectStore.begin(runId, key, {
      toolName: `media:${intent.type}`,
      argsHash: hashArgs({ intent, prompt: mediaPrompt }),
      ordinal: index,
      turn: 0,
      attempt: runContext?.attempt,
      replayPolicy: "never",
    });
    if (reservation.action === "reuse") return { ...(reservation.result || {}), __effectReused: true };
    if (reservation.action === "blocked") {
      return { type: intent.type === "tts" ? "audio" : intent.type, error: "上次媒体任务状态不确定，请确认上游任务后再重试", uncertain: true };
    }
    try {
      const result = await generateMediaAsync(intent, mediaPrompt);
      const decorated = result
        ? { ...result, __effectKey: key }
        : { type: intent.type === "tts" ? "audio" : intent.type, error: "媒体模型未返回结果", __effectKey: key };
      effectStore.complete(runId, key, decorated);
      return decorated;
    } catch (error) {
      effectStore.markUncertain(runId, key, String(error?.message || error));
      return { type: intent.type === "tts" ? "audio" : intent.type, error: String(error?.message || error), uncertain: true };
    }
  };
  const mediaPromise = mediaIntents.length
    ? Promise.all(mediaIntents.map((it, index) => runMediaEffect(it, index)))
    : Promise.resolve([]);
  let mediaItems = [];
  let mediaFlushing = null;
  async function deliverUnifiedMedia() {
    if (mediaFlushing) return mediaFlushing;
    mediaFlushing = (async () => {
      const results = await Promise.resolve(mediaPromise).catch((e) => {
        try { writer.push("note", { text: `出图未成功：${explainMediaError(e)}。思考和工具不受影响。` }); } catch {}
        return [];
      });
      const items = [];
      const deliveredKeys = new Set(persistedTurn.mediaKeys);
      for (const mr of results || []) {
        if (!mr) continue;
        if (mr.error && !mr.url) {
          const kind = mr.type === "video" ? "视频模型这次没出成片" : mr.type === "audio" ? "配音这次没出成" : "图像模型这次没出成图";
          try { writer.push("note", { text: `${kind}：${mr.error}` }); } catch {}
          continue;
        }
        if (!mr.url) continue;
        if (mr.artifactUrl) { mr.url = mr.artifactUrl; mr.localized = true; }
        else {
          // 本地化契约：外站临时链接必须先落到本地。没落成不能静默——
          // 以前这里是 try { ... } catch {}，失败后 mr.url 仍是外站地址，
          // 界面看起来正常，等链接过期才发现产物根本不在本地。
          const saved = await saveArtifact(mr);
          mr.url = saved.url;
          mr.localized = saved.local;
          if (!saved.local) {
            mr.localizeError = saved.reason;
            try { writer.push("note", { text: `⚠️ ${mr.type === "video" ? "视频" : mr.type === "audio" ? "配音" : "图片"}已生成，但没能存到本地（${saved.reason}）。当前显示的是外站临时链接，过期后会失效，请尽快下载保存。` }); } catch {}
          }
          if (mr.__effectKey && runContext?.effects && runContext?.runId) {
            try { runContext.effects.complete(runContext.runId, mr.__effectKey, { ...mr, artifactUrl: mr.url }); } catch {}
          }
        }
        // 同一远程地址或同一已落盘路径只交付一次，避免模型重复引用时把同一文件发多遍。
        const deliveryKey = mediaDeliveryKey(mr.url);
        if (deliveredKeys.has(deliveryKey)) continue;
        deliveredKeys.add(deliveryKey);
        const clean = { ...mr };
        delete clean.__effectKey;
        delete clean.__effectReused;
        delete clean.artifactUrl;
        try { writer.push("media", clean); } catch {}
        items.push(clean);
      }
      mediaItems = items;
      return items;
    })();
    return mediaFlushing;
  }
  const mediaDelivered = mediaIntents.length
    ? mediaPromise.then(() => deliverUnifiedMedia())
    : Promise.resolve([]);
  void mediaDelivered;
  if (imageIntent) {
    try { writer.push("note", { text: "图像模型正在出图，完成后会显示在对话里。" }); } catch {}
  }
  if (videoIntent) {
    try { writer.push("note", { text: "视频模型正在出片，完成后会显示在对话里。" }); } catch {}
  }
  const onToolStart = (id, name, args, context = {}) => { touchTask(taskId, { stage: "执行工具", toolName: name }); writer.push("tool", { name, args, id, effectKey: context.effectKey || null, turn: context.turn ?? null, ordinal: context.ordinal ?? null, argsHash: context.argsHash || null }); };
  const onToolEnd = (id, name, args, out, context = {}) => {
    touchTask(taskId, { stage: "工具完成", toolName: name });
    const text = out?.text || "";
    writer.push("tool_end", { name, id, effectKey: context.effectKey || null, turn: context.turn ?? null, ordinal: context.ordinal ?? null, isError: out?.isError === true, uncertain: out?.uncertain === true, reused: out?.reused === true, output: text.slice(0, 2000) });
    const media = explicitToolMedia(out, { id, name });
    if (media?.url) writer.push("media", media);
  };
  const onCheckpoint = createRunCheckpointWriter(writer, runContext);
  let history = [...formatSessionHistory(hist), { role: "user", content: mediaAwarePrompt(message, []) }];
  if (shouldInjectFullMemory(message)) setLastUserQuery(message);
  bindTodoSession(sessionId);
  bindWorkmemSession(sessionId);
  const sections = assembleYuanshuSystem({
    message,
    skills: loadSkillIndex(),
    experience: loadExperienceIndex(),
    fullMemory: shouldInjectFullMemory(message) ? loadMemory() : [],
    todos: formatTodoPrompt(sessionId),
    hist,
    rules: loadProjectRules(),
    // AIBody 运行协调：模式策略 + 状态提供者摘要。
    // 之前这份 directive 只传给了子智能体（executionContext.aibodyContext），
    // **主角色根本收不到**——而 directiveFor 里那些话（母体协调身份/记忆/角色治理）
    // 恰恰是写给主角色的。runtime 段本来就存在，只是一直没人往里传。
    runtime: runContext?.aibodyContext?.strategy || "",
    task: thinkOn ? "你可以调用 think 工具，在动手之前写下你的分析过程（理解、步骤、计划、可能的坑）。写完后再执行任务。think 的内容仅供调试，不展示给用户，可以放心写。" : "",
  }, gateway?.registry, { now: new Date(), model: chatModel, sessionId, message, cwd: _cwd, rhythm: readActivityRhythm(_cwd, { now: new Date(), sessionDir: _sessionDir }), since: lastTalkAt(sessionId), sessionStart: sessionStartedAt(hist) });
  history = prependAssembledSystem(history, sections);
  history = beginYuanshuEmotion(sessionId || "new", message, history);
  history = (await compactKeepArchive(history, (h) => maybeCompactHistory(h, chatModel))).view;
  // Plan 模式（unifiedChat 兕底路径）：工具定义层过滤为只读（read/web_search）——模型只能请求只读工具，无写路径
  // 注意：thinkOn=false 时 toolDefs 为 undefined（unifiedChat 内部才默认 UNIFIED_TOOLS），必须显式构建只读集，否则拦截被短路
  const isPlanLock = !!entry.planPending;
  const toolDefs = thinkOn && _THINK_TOOL ? [..._unifiedTools, _THINK_TOOL] : (thinkOn ? _unifiedTools : undefined);
  if (isPlanLock) {
    const base = toolDefs || _unifiedTools;
    const locked = base.filter(t => t.function?.name === "read" || t.function?.name === "web_search");
    writer.push("note", { text: "🔒 规划模式（工具级只读）· 批准后恢复写/执行" });
    console.log(`[plan] unifiedChat 工具级只读生效 → ${locked.map(t => t.function.name).join(", ")}`);
    return await runLockedChat(locked);
  }
  async function runLockedChat(locked) {
    // history 末条已是 handleChat 改写后的规划指令消息（含需求），直接复用；只传只读工具定义
    const result = await unifiedChat(chatModel, history, { executionBudgetMs: runContext?.executionBudgetMs, executionDeadlineAt: runContext?.executionDeadlineAt, onTool: onToolStart, onToolEnd, onCheckpoint, params, signal, tools: locked, sandboxMode: "read-only", sandboxWsRoot: _cwd, sandboxAsk: approvalAsk, effects: runContext?.effects, resumeSnapshot: runContext?.resume ? runContext.checkpoint?.historySnapshot : null, resumeCheckpointKind: runContext?.resume ? runContext.checkpoint?.checkpointKind : null, resumeToolPlan: runContext?.resume && runContext.checkpoint?.checkpointKind === "tool_plan" ? runContext.checkpoint?.toolPlan : null, executionContext: { runId: runContext?.runId, sessionId: runContext?.sessionId, attempt: runContext?.attempt, onEvent: runContext?.onEvent, aibodyContext: runContext?.aibodyContext, history } });
    if (!result || result.error) {
      clearTask(taskId, "error"); writer.push("error", { message: result?.error || "模型未返回内容" }); finishEmotion(); return;
    }
    if (result?.aborted || signal?.aborted) {
      try { persistUser(); persistYuanshuAssistant(entry.sm, abortedAssistantText(result), [], metadataFor(result)); } catch {}
      collected = abortedAssistantText(result);
      clearTask(taskId, "aborted"); finishEmotion(); return;
    }
    if (result?.paused) { await finishPausedChat(result); return; }
    const text = result.text;
    if (!text) { writer.push("error", { message: "模型未返回内容" }); finishEmotion(); return; }
    try { persistTrace(result.history || []); persistYuanshuAssistant(entry.sm, text, [], metadataFor(result)); } catch {}
    if (entry.agent) { try { entry.agent.dispose(); } catch {} entry.agent = null; }
    if (result.think) { writer.push("think", { text: result.think }); writer.push("think_end", {}); }
    writer.push("delta", { text });
    writer.push("done", { sessionId, model: result.usedModel, requestedModel });
    collected = text;
    clearTask(taskId, "done");
    finishEmotion();
  }
  async function finishPausedChat(result) {
    await deliverUnifiedMedia();
    persistUser();
    persistTrace(result.history || []);
    const text = [result.text, result.message].filter(Boolean).join('\n\n');
    persistYuanshuAssistant(entry.sm, assistantContentWithMedia(text, mediaItems), [], metadataFor(result));
    if (result.text && !result.streamed) writer.push('delta', { text: result.text });
    collected = text;
    clearTask(taskId, 'interrupted');
    finishEmotion();
    writer.push('interrupted', { reason: result.pauseReason, message: result.message, model: result.usedModel, requestedModel });
  }
  const chatOpts = {
    executionBudgetMs: runContext?.executionBudgetMs,
    executionDeadlineAt: runContext?.executionDeadlineAt,
    onNote: text => writer.push('note', { text }),
    onModel: model => writer.push('model_used', { model, requestedModel }),
    onTool: onToolStart,
    onToolEnd,
    onCheckpoint,
    onThink: (t) => { writer.push("think", { text: t }); },
    onThinkEnd: () => { writer.push("think_end", {}); },
    onDelta: (t) => { writer.push("delta", { text: t }); },
    params,
    signal,
    // 纯生图请求由媒体旁路完成，主模型只做一次文本收口；复合生图仍须保留
    // 工具循环，才能在图片完成的同时继续制作 PPT、网页或其它交付文件。
    tools: skipTools ? false : toolDefs,
    maxTurns: skipTools ? 1 : toolLoopMaxTurns({ imageIntent, videoIntent }),
    autoContinueTools: !skipTools && !imageIntent,
    imageIntent,
    videoIntent,
    sandboxMode: effectiveSandboxMode(_getAgentDir?.() || "", sessionId, { planLock: isPlanLock }),
    sandboxWsRoot: _cwd,
    sandboxAsk: approvalAsk,
    effects: runContext?.effects,
    resumeSnapshot: runContext?.resume ? runContext.checkpoint?.historySnapshot : null,
    resumeCheckpointKind: runContext?.resume ? runContext.checkpoint?.checkpointKind : null,
    resumeToolPlan: runContext?.resume && runContext.checkpoint?.checkpointKind === "tool_plan" ? runContext.checkpoint?.toolPlan : null,
    executionContext: { runId: runContext?.runId, sessionId: runContext?.sessionId, attempt: runContext?.attempt, onEvent: runContext?.onEvent, aibodyContext: runContext?.aibodyContext, history },
  };
  let result = await unifiedChat(chatModel, history, chatOpts);
  const adoptReplacement = (replacement, selected, reason) => {
    result = { ...replacement, streamed: true, usedModel: replacement.usedModel || { provider: selected.provider, id: selected.id } };
    switchedModel = { ...result.usedModel, sameModel: result.usedModel.provider === chatModel.provider && result.usedModel.id === chatModel.id, reason };
    writer.push('model_switched', { ...switchedModel, requestedModel });
    writer.push('response_replace', { text: result.text || '', think: result.think || '' });
  };
  // The resumed tool plan is consumed before the first model request. Do not
  // replay it again if output quality later triggers a fallback/pro model.
  chatOpts.resumeToolPlan = null;
  chatOpts.resumeSnapshot = null;
  chatOpts.resumeCheckpointKind = null;
  if (result?.aborted || signal?.aborted) {
    try { persistUser(); persistYuanshuAssistant(entry.sm, assistantContentWithMedia(abortedAssistantText(result), mediaItems), [], metadataFor(result)); } catch {}
    collected = abortedAssistantText(result);
    clearTask(taskId, "aborted"); finishEmotion(); return;
  }
  if (result?.empty && !result.text) {
    const fbModel = pickFallbackExcluding(chatModel);
    if (fbModel) {
      writer.push("note", { text: `⚠️ 模型空回复，切换 ${fbModel.provider}/${fbModel.id} 兑底…` });
      const fb = await unifiedChat(fbModel, history, { ...chatOpts, onDelta: undefined, onThink: undefined, onThinkEnd: undefined });
      if (fb?.aborted || signal?.aborted) {
        try { persistUser(); persistYuanshuAssistant(entry.sm, assistantContentWithMedia(abortedAssistantText(fb), mediaItems), [], metadataFor(fb)); } catch {}
        collected = abortedAssistantText(fb);
        clearTask(taskId, "aborted"); finishEmotion(); return;
      }
      if (fb?.paused) { await finishPausedChat(fb); return; }
      if (fb?.text && !fb.error && !fb.empty) adoptReplacement(fb, fbModel, '主模型空回复，备用模型重新回答');
      else result = { ...result, error: EMPTY_TURN_ERROR };
    } else {
      result = { ...result, error: EMPTY_TURN_ERROR };
    }
  }
  // 截断恢复仍耗尽时，把已经写入的工具历史交给备用模型续跑一次。
  // 这样单个模型的输出边界不会让长任务停在“已完成一半”的状态。
  if (result?.error === TRUNCATED_TOOL_ERROR) {
    const fbModel = pickFallbackExcluding(chatModel);
    if (fbModel && Array.isArray(result.history)) {
      writer.push("note", { text: `⚠️ ${TRUNCATED_TOOL_ERROR}，正在切换 ${fbModel.provider}/${fbModel.id} 接续已完成步骤…` });
      const fb = await unifiedChat(fbModel, result.history, { ...chatOpts, onDelta: undefined, onThink: undefined, onThinkEnd: undefined, resumeSnapshot: null, resumeCheckpointKind: null, resumeToolPlan: null });
      if (fb?.aborted || signal?.aborted) {
        try { persistUser(); persistTrace(fb?.history || result.history); persistYuanshuAssistant(entry.sm, assistantContentWithMedia(abortedAssistantText(fb), mediaItems), [], metadataFor(fb)); } catch {}
        collected = abortedAssistantText(fb);
        clearTask(taskId, "aborted"); finishEmotion(); return;
      }
      if (fb?.paused) { await finishPausedChat(fb); return; }
      if (fb?.text && !fb.error) adoptReplacement(fb, fbModel, '输出截断，备用模型接续已完成步骤');
      else if (fb?.history) result = { ...result, history: fb.history };
    }
  }
  if (result?.paused) { await finishPausedChat(result); return; }
  if (!result || result.error) {
    await deliverUnifiedMedia();
    if (mediaItems.length) {
      try { persistTrace(result?.history || []); } catch {}
      if (result?.text && !result.streamed) writer.push("delta", { text: result.text });
      try {
        persistYuanshuAssistant(entry.sm, assistantContentWithMedia(result?.text || "", mediaItems), [], metadataFor(result));
      } catch {}
      writer.push("done", { sessionId, model: result?.usedModel || null, requestedModel });
      collected = result?.text || "";
      clearTask(taskId, "done");
      finishEmotion();
      return;
    }
    try {
      persistTrace(result?.history || []);
      if (result?.text) persistYuanshuAssistant(entry.sm, result.text, [], metadataFor(result));
    } catch {}
    clearTask(taskId, "error");
    writer.push("error", { message: result?.error || "模型未返回内容，请稍后重试" });
    finishEmotion();
    return;
  }
  let text = result.text;
  if (!text) {
    await deliverUnifiedMedia();
    if (mediaItems.length || result.partial || result.truncated) {
      try {
        persistTrace(result.history || []);
        persistYuanshuAssistant(entry.sm, assistantContentWithMedia(result.partial ? lastPartialAssistantText(result.history || []) : "", mediaItems), [], metadataFor(result));
      } catch {}
      writer.push("done", { sessionId, model: result.usedModel || null, requestedModel });
      clearTask(taskId, "done");
      finishEmotion();
      return;
    }
    writer.push("error", { message: "模型未返回内容，请稍后重试" });
    finishEmotion();
    return;
  }
  // ══ NEEDS_PRO 自报升级（Reasonix P3，2026-08-19）：模型认为任务超纲 → 用 pro 模型重试一次（纯自报、无静默升级）
  const proMatch = NEEDS_PRO_RE.exec(text || "");
  if (proMatch) {
    const proModel = routeProCandidate();
    if (proModel && (proModel.provider !== chatModel.provider || proModel.id !== chatModel.id)) {
      writer.push("note", { text: `🚀 模型自报任务超纲，升级 ${proModel.provider}/${proModel.id} 重试${proMatch[1] ? `（原因：${proMatch[1].trim()}）` : ""}…` });
      const proResult = await unifiedChat(proModel, result.history || history, { executionBudgetMs: runContext?.executionBudgetMs, executionDeadlineAt: runContext?.executionDeadlineAt, onTool: onToolStart, onToolEnd, onCheckpoint, params, signal, tools: toolDefs, sandboxMode: chatOpts.sandboxMode, sandboxWsRoot: _cwd, sandboxAsk: approvalAsk, effects: runContext?.effects, resumeSnapshot: null, resumeCheckpointKind: null, resumeToolPlan: null, executionContext: { runId: runContext?.runId, sessionId: runContext?.sessionId, attempt: runContext?.attempt, onEvent: runContext?.onEvent, aibodyContext: runContext?.aibodyContext, history } });
      if (proResult?.paused) { await finishPausedChat(proResult); return; }
      if (proResult?.text && !proResult.error) {
        const proTxt = String(proResult.text).trim();
        if (!NEEDS_PRO_RE.test(proTxt)) {
          text = proTxt;
          adoptReplacement(proResult, proModel, '模型自报任务超纲，升级模型回答');
          console.log(`[元枢] NEEDS_PRO 升级成功: ${proModel.provider}/${proModel.id}`);
        }
      }
    }
  }
  // 输出质量守卫（2026-08-19 机制化）：兑底通道统一检测 空回复/纯思考/复读 → 自动切 fallback 重试
  const rkU = sessionId || _findKeyByEntry(entry) || "new";
  const anomaly = classifyAnomaly({ sessionKey: rkU, text, think: result.think || "", sessionFile: entry.sm?.sessionFile, baseline: replyBaseline });
  // 2026-08-31 修复重复回话：守卫检测到异常（复读/空/纯思考/marker/amnesia）后，若备用模型也失败
  //    （fallback 无文本 / 无可用备用通道），text 仍是异常原文——此时绝不能把它写入会话，否则
  //    重复/空文本落盘，下次被当历史喂回模型 → 复读死循环。标记异常未解决，跳过 assistant 落盘。
  let anomalyUnresolved = false;
  if (anomaly.type !== "none") {
    console.log(`[元枢] 输出守卫(${anomaly.type}): ${chatModel.provider}/${chatModel.id} ${anomaly.reason} → 自动切换重试`);
    const fbModel = pickFallbackExcluding(chatModel);
    if (fbModel) {
      writer.push("note", { text: `⚠️ ${anomaly.reason}，自动切换 ${fbModel.provider}/${fbModel.id} 重试…` });
      const fb = await directChat(fbModel, message, fallbackHistoryForDirectChat(history), { signal });
      if (fb?.text) {
        // 落盘时要带标记（2026-09-16）：只推事件不落盘的话，刷新/换设备就变回"静默换模型"了
        text = `（已切换 ${fbModel.provider}/${fbModel.id} 重新生成的回复）\n${fb.text}`;
        adoptReplacement({ ...fb, text, history: result.history }, fbModel, `${anomaly.reason} → 自动切换重试`);
        recordReply(rkU, text);
        // 静默换模型是用户最直接的"乱做"体感（原话："静默换成 agnes 3.0"）：显式推事件，界面标出兜底模型
      } else {
        anomalyUnresolved = true;
        writer.push("note", { text: "⚠️ 输出守卫触发，但备用模型也无回复（请手动切换模型或重试）" });
      }
    } else {
      anomalyUnresolved = true;
      writer.push("note", { text: `⚠️ ${anomaly.reason}，且无可用备用通道（全链冷却），请稍后重试或手动切换模型` });
    }
  } else {
    recordReply(rkU, text);
  }
  try {
    await deliverUnifiedMedia();
    // 异常未解决时不写 assistant（避免复读/空/纯思考文本落盘污染会话，防止下轮复读死循环）
    if (!anomalyUnresolved) {
      persistTrace(result.history || history);
      persistYuanshuAssistant(entry.sm, assistantContentWithMedia(text, mediaItems), [], metadataFor(result));
    }
  } catch {}
  if (entry.agent) { try { entry.agent.dispose(); } catch {} entry.agent = null; }
  if (!entry.sm.getSessionName()) { try { entry.sm.appendSessionInfo(message.slice(0, 24)); } catch {} }
  if (result.think && !result.streamed) { writer.push("think", { text: result.think }); writer.push("think_end", {}); }
  if (!result.streamed) writer.push("delta", { text });
  writer.push("done", { sessionId, model: result.usedModel || { provider: chatModel.provider, id: chatModel.id }, requestedModel });
  collected = text;
  clearTask(taskId, "done");
  finishEmotion();
  console.log(`[元枢] 统一通道: ${(result.usedModel || chatModel).provider}/${(result.usedModel || chatModel).id}`);
}

// ============================================================
// Agent 活动事件环（借鉴 dsh 轨迹设计：小语在干嘛，前端实时可见）
// 内存环：保留最近 200 条，不持久化（历史仍在 session 文件）
// ============================================================
const agentEventRing = [];
const AGENT_EVENT_MAX = 200;

// ── 任务进度快照：前端息屏/断线/刷新后，可查"任务是否还在跑、跑到哪一步" ──
// 内存 Map（sessionId → 快照）；任务结束保留 60s 供前端查"刚结束"，之后自动清除
export const taskProgress = new Map();
export function touchTask(sessionId, patch = {}) {
  if (!sessionId) return;
  const t = taskProgress.get(sessionId) || { sessionId, status: "running", stage: "处理中", startedAt: Date.now() };
  Object.assign(t, patch, { updatedAt: Date.now() });
  taskProgress.set(sessionId, t);
}
export function clearTask(sessionId, status = "done") {
  if (!sessionId) return;
  const t = taskProgress.get(sessionId);
  if (!t) return;
  t.status = status;
  t.updatedAt = Date.now();
  // 60s 后清除，前端可查"刚结束"；unref：纯内存清理，不该阻止进程退出（也避免测试被挂 60s）
  setTimeout(() => { taskProgress.delete(sessionId); }, 60000).unref?.();
}

export function handleAgentEventIn(req, res, body) {
  if (!body || !body.type) return json(res, 400, { error: "bad event" });
  const ev = {
    agent: body.agent || "小语",
    type: String(body.type).replace(/^pi\//, ""),
    data: body.data || {},
    ts: body.ts || new Date().toISOString(),
  };
  agentEventRing.push(ev);
  if (agentEventRing.length > AGENT_EVENT_MAX) agentEventRing.shift();
  return json(res, 200, { ok: true });
}

export function handleAgentEventOut(res) {
  return json(res, 200, { events: agentEventRing.slice(-80) });
}

// ── 工具大响应落盘（08-29 TrueForge 策略②对标）：>50KB 写文件，上下文只留预览+路径 ──
// 之前 truncate 直接丢信息；落盘后模型可用 read 工具按需读全文。目录按日分桶，7 天前的自动清。
// M1 路径外部化：落盘目录进系统临时目录，跨机器可移植
const TOOL_SPILL_DIR = path.join(os.tmpdir(), "pi-web-toolout");
const TOOL_SPILL_LIMIT = 50 * 1024;
function spillIfHuge(toolName, text) {
  const s = String(text || "");
  if (s.length <= TOOL_SPILL_LIMIT) return s;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(TOOL_SPILL_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${toolName}-${Date.now()}.txt`);
    fs.writeFileSync(file, s);
    // 清 7 天前
    for (const d of fs.readdirSync(TOOL_SPILL_DIR)) {
      const p = path.join(TOOL_SPILL_DIR, d);
      if (d < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
    }
    const preview = s.slice(0, 800);
    return `${preview}\n\n[完整输出 ${s.length} 字符已落盘: ${file} — 需要更多内容时用 read 工具读取该路径]`;
  } catch { return s.slice(0, TOOL_SPILL_LIMIT) + "\n...[截断]"; }
}
