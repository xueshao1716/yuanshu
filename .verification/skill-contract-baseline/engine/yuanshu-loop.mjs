// engine/yuanshu-loop.mjs —— 元枢主循环的工具轮（调度器 + Code Mode 挂载）
// Gateway 的 StandardAgentLoop 仍是旁路演示；真正长的是 unifiedChat 这条。
import { scheduleToolCalls, ABORTED_MARKER } from "./tool-scheduler.mjs";
import { policyDecide as defaultPolicy } from "./dsh-keys.mjs";
import { wrapUntrusted } from "./prompt-security.mjs";
import { jitRulesForPath as defaultJit } from "./context-loader.mjs";
import { coachToolFailure } from "./yuanshu-protocol.mjs";
import { recordStuckEvent, detectStuck } from "./yuanshu-stuck.mjs";
import { coachSearchRound } from "./yuanshu-session.mjs";
import { gateSandboxCall } from "./yuanshu-sandbox.mjs";
import { hashArgs } from "./run-effects.mjs";

const handlers = Object.create(null);

export function registerYuanshuExecutor(name, fn) {
  if (name && typeof fn === "function") handlers[name] = fn;
}

export function yuanshuExecutor(name) {
  return handlers[name] || null;
}

export function toolCallLoopKey(name, args) {
  const n = String(name || "");
  const a = args && typeof args === "object" ? args : {};
  const cmd = String(a.command || a.cmd || "");
  // SVG is ordinary file content: different chunks/edits are progress, not a
  // repeated drawing attempt. Preserve path, content and append in the key.
  if ((n === "bash" || n === "dsh") && /images\/generations|\/v3\/images|绘图模型|generateImage/i.test(cmd)) return `${n}:draw`;
  return `${n}:${JSON.stringify(a)}`;
}

export function attachYuanshuCodeTool(tools, codeMode) {
  if (!Array.isArray(tools) || !codeMode?.runCodeToolDef) return tools;
  const def = codeMode.runCodeToolDef();
  if (def?.handler) registerYuanshuExecutor("run_code", (args) => def.handler(args));
  if (tools.some((t) => (t.function?.name || t.name) === "run_code")) return tools;
  tools.push({
    type: "function",
    function: {
      name: def.name || "run_code",
      description: def.description || "",
      parameters: def.parameters || { type: "object", properties: {} },
    },
  });
  return tools;
}

function exclusiveDef(name) {
  if (name === "write" || name === "edit" || name === "bash" || name === "run_code" || name === "dsh_task" || name === "delegate_task") {
    return { parallel: false };
  }
  return { parallel: true };
}

export function toolReplayPolicy(name) {
  if (["read", "web_search", "list_channels", "activate_skill", "todo_read"].includes(name)) return "safe"
  if (["write", "edit", "plan_files", "todo_write"].includes(name)) return "state-checked"
  return "never"
}

// Rebuild OpenAI tool-call messages from a durable checkpoint. Completed
// entries are already represented in history/effects and must not be replayed;
// pending/uncertain entries are handed to the effects ledger for its normal
// reuse or fail-closed decision.
export function toolCallsFromPlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan
    .filter(item => item && item.args && typeof item.args === "object" && item.status !== "completed" && item.status !== "error" && item.status !== "failed")
    .map((item, index) => {
      const args = item.args && typeof item.args === "object" ? item.args : {};
      const call = {
        id: String(item.id || `resume-${index}`),
        type: "function",
        function: {
          name: String(item.name || ""),
          arguments: JSON.stringify(args),
        },
      };
      // Keep the original ordinal out of provider payloads while letting the
      // scheduler derive the same durable effect key after completed entries
      // have been filtered from the replay list.
      Object.defineProperty(call, "__ordinal", {
        value: Number.isInteger(item.ordinal) ? item.ordinal : index,
        enumerable: false,
      });
      return call;
    })
    .filter(item => item.function.name);
}

export async function runYuanshuToolRound({
  toolCalls = [],
  history = [],
  execute,
  signal,
  onTool,
  onToolEnd,
  seenCalls = new Map(),
  jitInjected = new Set(),
  spill = (_n, t) => t,
  policyDecide = defaultPolicy,
  jitForPath = defaultJit,
  stuckEvents = [],
  sandboxMode = "workspace-write",
  sandboxWsRoot = "",
  sandboxAsk,
  effects = null,
  executionContext = null,
} = {}) {
  const tools = {
    getDef: exclusiveDef,
    execute: async (name, args) => {
      const pd = policyDecide(name, args);
      if (pd?.decision === "deny") return { text: `[系统拦截] ${pd.note}`, isError: true, denied: true };
      const sb = await gateSandboxCall({ mode: sandboxMode, name, args, wsRoot: sandboxWsRoot, ask: sandboxAsk });
      if (!sb.ok) {
        return { text: `${sb.tag}\n${sb.note}`, isError: true, denied: true };
      }
      const raw = await execute(name, args, { signal, ...(executionContext || {}) });
      const out = raw && typeof raw === "object" ? raw : { text: String(raw || ""), isError: true };
      if ((name === "read" || name === "write" || name === "edit") && args?.path) {
        try {
          const jits = jitForPath(args.path) || [];
          if (jits.length) {
            const key = String(jits[0]).slice(0, 30);
            if (!jitInjected.has(key)) {
              jitInjected.add(key);
              out.text = `[该目录约定 GEMINI.md]\n${jits.join("\n")}\n\n---\n${out.text}`;
            }
          }
        } catch {}
      }
      const searchCount = 1 + (stuckEvents || []).filter((e) => e.name === "web_search").length;
      return coachSearchRound(name, searchCount, coachToolFailure(name, args, out));
    },
  };

  const results = await scheduleToolCalls({
    toolCalls,
    tools,
    onTool,
    onToolEnd,
    signal,
    maxParallel: 4,
    effects,
    executionContext,
    replayPolicy: toolReplayPolicy,
  });

  const toolPlan = results.map(({ id, name, args, out, effectKey, ordinal: resultOrdinal }, ordinal) => ({
    id,
    name,
    args,
    argsHash: hashArgs(args),
    ordinal: Number.isInteger(resultOrdinal) ? resultOrdinal : ordinal,
    effectKey: effectKey || null,
    status: out?.uncertain ? "uncertain" : out?.isError === true ? "error" : "completed",
    isError: out?.isError === true,
  }));

  const searches = results.filter((r) => r.name === "web_search");
  if (searches.length >= 2) {
    const last = searches[searches.length - 1];
    last.out = coachSearchRound("web_search", searches.length, last.out || { text: "" });
  }

  for (const item of results) {
    const { id, name, args, out } = item;
    const text = String(out?.text || "");
    const denied = !!out?.denied || text.startsWith("[系统拦截]");
    const aborted = text === ABORTED_MARKER;
    if (!denied && !aborted) {
      const sig = toolCallLoopKey(name, args);
      seenCalls.set(sig, (seenCalls.get(sig) || 0) + 1);
      const failed = out?.isError === true;
      if (!failed && seenCalls.get(sig) >= 3) {
        history.push({ role: "tool", tool_call_id: id, content: wrapUntrusted(name, spill(name, text)) });
        return { history, toolPlan, stop: { error: "模型工具调用陷入循环，已中断（建议换一种方式提问）" } };
      }
      if (failed && seenCalls.get(sig) >= 5) {
        out.text = `[系统提示] 工具 ${name} 已连续失败 5 次（最近错误：${text.slice(0, 100)}）。请换一种方式完成任务，不要重复相同的失败操作。`;
      }
      stuckEvents.push(recordStuckEvent(name, args, out));
      const stuck = detectStuck(stuckEvents);
      if (stuck) {
        out.text = `${out?.text || text}\n[宿主纠偏] ${stuck.hint}`;
        history.push({ role: "tool", tool_call_id: id, content: wrapUntrusted(name, spill(name, out.text)) });
        return { history, toolPlan, stop: { error: stuck.hint } };
      }
    }
    history.push({ role: "tool", tool_call_id: id, content: wrapUntrusted(name, spill(name, out?.text)) });
  }
  return { history, toolPlan };
}
