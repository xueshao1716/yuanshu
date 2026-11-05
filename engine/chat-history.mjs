// ===== chat-history.mjs —— 对话历史/工具调用清洗（2026-11-05 从 unified-chat.mjs 拆出）=====
//
// 这块原来在 unified-chat.mjs 里占了约 300 行，全是纯函数：清洗工具调用、格式化历史、
// 生成运行快照/检查点、决定工具循环轮数。它们不依赖任何运行时状态，搬出来以后
// 改历史格式不需要在 94KB 的主对话文件里找位置。
//
// 依赖全部来自既有模块，无新增副作用。
import { extractMessages, attachmentLines } from "./session-utils.mjs";
import { directChat } from "./model-client.mjs";
import { hashArgs } from "./run-effects.mjs";
import { normalizeToolArgs } from "./tool-args.mjs";
import { projectToolResult } from "./reasonix-tools.mjs";

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
    if (m?.role === "user") break; // 只回收本轮正文；越过用户消息会把上一轮的回答当成本轮结果
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
// DeepSeek 思考模式硬规则（2026-10-17 真机 400）：
// 带 tool_calls 的 assistant 消息必须把 reasoning_content 原样回传，否则整轮请求被拒——
// {"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}
// 会话存储里这条推理在 extractMessages 中被还原成 item.think，重建历史时必须接回去（见下方 push）。
// 只对 DeepSeek 系模型回传：其他 OpenAI 兼容端点没有这条要求，别给它们塞未知字段。
export function carriesReasoningDuty(model) {
  const id = String(model?.id || "");
  const provider = String(model?.provider || "");
  return provider === "deepseek" || /deepseek/i.test(id);
}

export function formatSessionHistory(hist = [], { projectTool = projectToolResult, carryReasoning = false } = {}) {
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
    // DeepSeek 思考模式：带 tool_calls 的这条必须带 reasoning_content，否则 400（见 carriesReasoningDuty）
    const replayReasoning = carryReasoning ? String(item.think || "").trim() : "";
    out.push({
      role: "assistant",
      content: text || null,
      ...(replayReasoning ? { reasoning_content: replayReasoning } : {}),
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

export function snapshotMessage(message, maxChars) {
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

export function toolPlanFor(toolCalls, completed = null) {
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

export function createRunCheckpointWriter(writer, runContext) {
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

export function emitRoundStream(opts, msg) {
  const { think, text } = splitAssistantPayload(msg);
  try { if (think && opts?.onThink) opts.onThink(think); } catch {}
  try { if (text && opts?.onDelta) opts.onDelta(text); } catch {}
  return { think, text };
}
