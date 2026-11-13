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
import { validateToolArgs, toolSchemaIndex, argsErrorText } from "./tool-schema.mjs";

const handlers = Object.create(null);

// ── 空输出 / 重复调用：给她信息，不拦她（2026-11-13）────────────────────────
// 那次 4xx 分钟的空转里，60 多次 bash 每条都不一样、每条都 ok=true，旧的两道闸
//（同参数 3 次停、结果指纹 4 次停）全都没响；而真正缺的是"这次调用到底有没有生效"。
// 用户原话：「哪怕是熔断，就是发现自己错了，立马分析重新补上正确的路，而不是不干了。」
// 所以这里只做两件事，都不中止、不弹给用户：
//   ① 工具跑完却是空输出 → 补一句"执行完成但没有输出（不是失败）"，别留白让她以为没拿到结果；
//   ② 同一调用连续 3 次、或连续 3 次空返回 → 塞一条内部自查（system，只给模型看）：
//      重复了几次、上次返回是什么、可能是什么原因、换哪条路继续。
const SELF_CHECK_AT = 3;      // 第 3 次开始自查
const SELF_CHECK_EVERY = 3;   // 之后每 3 次再自查一次（6、9…）
const BLANK_RESULT_TEXTS = new Set(["", "（无输出）", "(无输出)", "无输出", "null", "undefined", "{}", "[]"]);
const loopStates = new WeakMap();

/** 工具结果是不是"空转"：没有输出、或只有空占位。 */
export function isEmptyToolText(text) {
  return BLANK_RESULT_TEXTS.has(String(text ?? "").trim());
}

/** 空输出的标准说法：说清"跑过了、没东西、别原样重跑"。 */
export function emptyResultText(name) {
  return `（工具 ${name} 执行完成，但没有输出。这不是失败：命令跑过了，只是没打印东西——grep/find 没匹配到、命令只改了文件、或者参数给错了。别原样重跑：换关键词、换路径或换工具继续。）`;
}

// ── 长跑进度提示（2026-11-13）────────────────────────────────────────────────
// 用户原话：「最新的对话，执行了 44 轮了，没有反馈，究竟在干啥。」
// 那 44 轮是真实只读考古，不是死循环；错在**中途不给任何进度**——持久化和进度都只在
// 收尾发生，人在 29 分钟里什么也看不到。所以每 10 个工具轮，经 opts.onNote 给用户一条
// 人话：还在干活、最近在动哪个文件/命令。只说进展，不说"卡住/重试/中断"；不返回 stop，
// 不碰任何停止或中止语义。
const PROGRESS_EVERY = 10;        // 每 10 轮报一次（10、20、30…）
const PROGRESS_MAX_NOTES = 5;     // 一次对话最多 5 条（50 轮封顶），长跑也不刷屏
const PROGRESS_RECENT_TOOLS = 3;  // 摘要取最近 3 次工具调用
const PROGRESS_SUMMARY_MAX = 40;  // 摘要整行 ≤40 字
const PROGRESS_ITEM_MAX = 20;     // 单条「工具名 + 目标」≤20 字

function clipText(text, max) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

/** 一次工具调用 → 「工具名 + 参数首行/目标路径」，压缩到 PROGRESS_ITEM_MAX 字。 */
export function toolCallSummary(name, args) {
  const n = String(name || "").trim() || "工具";
  const a = args && typeof args === "object" ? args : {};
  const pathBase = (value) => {
    const parts = String(value ?? "").trim().split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  };
  // 读写类只留文件名：全路径又长又占地方，用户只需要知道在动哪个文件。
  const raw = ["read", "write", "edit"].includes(n)
    ? pathBase(a.path || a.file_path || a.filePath)
    : String(a.command || a.cmd || a.query || a.q || a.path || a.pattern || a.url || a.target || a.prompt || a.task || "");
  // 摘要是给人看的一行提示，不是可复跑的命令：去掉引号，别在截断后留半个引号。
  const cleaned = raw.replace(/["']/g, "").replace(/\s+/g, " ").trim();
  if (n.length >= PROGRESS_ITEM_MAX) return clipText(n, PROGRESS_ITEM_MAX);
  const target = clipText(cleaned, PROGRESS_ITEM_MAX - n.length - 1);
  return target ? `${n} ${target}` : n;
}

/** 最近几次工具压成一行：从最近一次往前拼，旧的按剩余预算截短，拼不下就停。 */
export function compactToolTrail(list, max = PROGRESS_SUMMARY_MAX) {
  const items = (Array.isArray(list) ? list : []).map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!items.length) return "";
  const recent = items.slice(-PROGRESS_RECENT_TOOLS).map((value) => clipText(value, PROGRESS_ITEM_MAX));
  let line = recent[recent.length - 1];
  for (let i = recent.length - 2; i >= 0; i--) {
    const room = max - line.length - " / ".length;
    if (room < 6) break;
    line = `${clipText(recent[i], room)} / ${line}`;
  }
  return clipText(line, max);
}

/** 给用户看的进度文案：拿得到摘要就带上，拿不到就只写轮数。 */
export function progressNoteText(round, trail) {
  const recent = compactToolTrail(trail);
  return recent
    ? `已执行 ${round} 轮工具，仍在处理（最近：${recent}）`
    : `已执行 ${round} 轮工具，仍在处理`;
}

/**
 * 记录一轮工具执行，并在跨过 10 的整数倍时发一条进度。
 * @returns {{text:string, round:number}|null} 发出的那条；没发就是 null（永远不返回 stop）。
 */
export function noteToolRoundProgress(state, onNote, results) {
  const executed = (Array.isArray(results) ? results : [])
    .filter((item) => item && item.name && item.out?.text !== ABORTED_MARKER);
  if (!executed.length) return null;
  state.rounds = (Number(state.rounds) || 0) + 1;
  for (const item of executed) state.recentTools.push(toolCallSummary(item.name, item.args));
  if (state.recentTools.length > PROGRESS_RECENT_TOOLS) state.recentTools = state.recentTools.slice(-PROGRESS_RECENT_TOOLS);
  if (typeof onNote !== "function") return null;
  if (state.progressNotes >= PROGRESS_MAX_NOTES) return null;
  if (state.rounds % PROGRESS_EVERY !== 0) return null;
  const payload = { text: progressNoteText(state.rounds, state.recentTools), round: state.rounds };
  state.progressNotes += 1;
  try { onNote(payload); } catch {}
  return payload;
}

function selfCheckState(history) {
  let state = loopStates.get(history);
  if (!state) {
    state = {
      sig: null, same: 0, blank: 0, lastText: "",
      rounds: 0, progressNotes: 0, recentTools: [],
    };
    loopStates.set(history, state);
  }
  return state;
}

/**
 * 同一调用反复出现时给模型的自查文案。不返回 stop，只返回要挂上去的提示。
 * @returns {{count:number, line:string, message:string}|null}
 */
function selfCheckNote(state, name, prevText) {
  const same = state.same;
  const blank = state.blank;
  const count = blank >= SELF_CHECK_AT ? blank : same;
  if (count < SELF_CHECK_AT) return null;
  if (!(count === SELF_CHECK_AT || count % SELF_CHECK_EVERY === 0)) return null;
  const what = blank >= SELF_CHECK_AT ? `连续 ${blank} 次空返回` : `同一个调用已连续 ${same} 次`;
  const excerpt = prevText ? `上次返回：${String(prevText).replace(/\s+/g, " ").slice(0, 160)}` : "上次返回为空。";
  return {
    count,
    line: `[自查] ${what}（${name}）：换参数、换工具或换目标继续，别原样重跑。`,
    message: [
      `【内部自查 · 不用告诉用户】${what}（工具 ${name}，参数一致）。${excerpt}`,
      "常见原因：① 参数没变，返回当然不变；② 命令成功但没有输出（grep 没匹配/路径不对/只改了文件）；③ 这个工具不适合这一步；④ 目标文件或接口根本不存在。",
      "处理方式：换一条路把事做完——改参数、换工具、换目标，或者基于已经读到的内容直接给结论。不要原样重跑，也不要停下来等用户确认。",
    ].join("\n"),
  };
}

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
  // delegate_task 现在是只读研究员（不写不跑命令），同一轮多个可并行；写类工具仍是屏障
  if (name === "write" || name === "edit" || name === "bash" || name === "run_code" || name === "dsh_task") {
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
  onNote, // 长跑进度：每 10 轮收到一条 { text, round }（可选，不发也不影响任何语义）
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
  toolDefs = null,
} = {}) {
  const schemas = toolSchemaIndex(toolDefs);
  const tools = {
    getDef: exclusiveDef,
    execute: async (name, args) => {
      const checked = validateToolArgs(schemas.get(name), args);
      if (!checked.ok) return { text: argsErrorText(name, checked.errors), isError: true };
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

  const loopState = selfCheckState(history);
  // 长跑进度：每 10 轮给用户报一次"还在干什么"。只发提示，不改 stop。
  noteToolRoundProgress(loopState, onNote, results);
  for (const item of results) {
    const { id, name, args, out } = item;
    const text = String(out?.text || "");
    const denied = !!out?.denied || text.startsWith("[系统拦截]");
    const aborted = text === ABORTED_MARKER;
    const hints = [];
    if (!denied && !aborted) {
      // 空输出先补一句人话：留白会让模型以为"没拿到结果"，于是原样再调一次（真机事故）。
      const prevText = loopState.lastText;
      const blank = isEmptyToolText(out?.text);
      if (blank) out.text = emptyResultText(name);
      const sig = toolCallLoopKey(name, args);
      seenCalls.set(sig, (seenCalls.get(sig) || 0) + 1);
      loopState.same = sig === loopState.sig ? loopState.same + 1 : 1;
      loopState.sig = sig;
      loopState.blank = blank ? loopState.blank + 1 : 0;
      const failed = out?.isError === true;
      if (failed && seenCalls.get(sig) >= 5) {
        out.text = `[系统提示] 工具 ${name} 已连续失败 5 次（最近错误：${String(out?.text || text).slice(0, 100)}）。换一种方式完成任务，不要重复相同的失败操作。`;
      }
      // 自查：不中止、不报给用户，只把"你已经做过、上次返回是什么"摆到模型面前。
      const check = selfCheckNote(loopState, name, blank ? "" : prevText);
      if (check) {
        out.text = `${check.line}\n${out?.text || ""}`;
        hints.push(check.message);
      }
      loopState.lastText = String(out?.text || "");
      stuckEvents.push(recordStuckEvent(name, args, out));
      const stuck = detectStuck(stuckEvents);
      if (stuck) {
        out.text = `${out?.text || text}\n[宿主纠偏] ${stuck.hint}`;
        history.push({ role: "tool", tool_call_id: id, content: wrapUntrusted(name, spill(name, out.text)) });
        for (const hint of hints) history.push({ role: "system", content: hint });
        if (stuck.soft) continue;
        return { history, toolPlan, stop: { error: stuck.hint } };
      }
    }
    history.push({ role: "tool", tool_call_id: id, content: wrapUntrusted(name, spill(name, out?.text)) });
    // 内部自查放在 tool 结果之后：tool_calls 与 tool 结果必须相邻，中间不能插 system。
    for (const hint of hints) history.push({ role: "system", content: hint });
  }
  return { history, toolPlan };
}
