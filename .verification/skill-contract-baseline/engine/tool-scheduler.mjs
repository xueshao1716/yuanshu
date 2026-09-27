// ===== tool-scheduler.mjs —— 工具调度器（dsh 调度思想落地）=====
// 设计（对应 docs/dsh-design-notes.md 亮点 2）：
//   - 排他调用（工具注册时 parallel:false）形成屏障：屏障前的并行组全部完成后才执行它，
//     它完成后再放行后续并行组 —— 前后调用绝不与它重叠。
//   - 并行调用使用有界滚动池：并发上限 maxParallel，超出排队；分发可重叠，
//     但结果严格按模型调用顺序收集（保序）。
//   - Abort 语义不撒谎：已启动的调用排空（drain）等待完成；未启动的补合成错误结果，
//     保证消息序列完整（回放有效）。调度器本身不伪造结果。
//
// 用法：
//   const results = await scheduleToolCalls({ toolCalls, tools, onTool, onToolEnd, signal, maxParallel });
//   results: [{ id, name, args, out }] —— 与 toolCalls 同序。

export const ABORTED_MARKER = "[系统提示] 工具调用已中止（未执行）";

import { canonicalStepKey, hashArgs } from "./run-effects.mjs";

export async function scheduleToolCalls({
  toolCalls = [],
  tools = null,
  onTool = null,
  onToolEnd = null,
  signal = null,
  maxParallel = 4,
  effects = null,
  executionContext = null,
  replayPolicy = null,
} = {}) {
  const results = [];
  let i = 0;
  const n = toolCalls.length;
  while (i < n) {
    // 找连续可并行段 [i, j)：遇到排他调用即结束（排他调用单独成屏障）
    let j = i;
    while (j < n && !isExclusive(toolCalls[j], tools)) j++;
    if (j === i) {
      // 屏障：单独执行排他调用
      results.push(await runOne(toolCalls[i], { tools, onTool, onToolEnd, signal, effects, executionContext, replayPolicy, ordinal: i }));
      i++;
    } else {
      const seg = toolCalls.slice(i, j);
      const done = await runParallel(seg, { tools, onTool, onToolEnd, signal, effects, executionContext, replayPolicy, maxParallel, ordinalBase: i });
      results.push(...done);
      i = j;
    }
  }
  return results;
}

// ── 并行段：有界滚动池 + 结果保序 ──
async function runParallel(seg, ctx) {
  const out = new Array(seg.length); // 按下标写，天然保序
  let cursor = 0;
  async function worker() {
    while (cursor < seg.length) {
      const idx = cursor++;
      const tc = seg[idx];
      if (ctx.signal?.aborted) {
        // 未启动 → 补合成错误结果（不执行）
        out[idx] = abortedResult(tc, { ...ctx, ordinal: (ctx.ordinalBase || 0) + idx });
        continue;
      }
      out[idx] = await runOne(tc, { ...ctx, ordinal: (ctx.ordinalBase || 0) + idx });
    }
  }
  const poolSize = Math.max(1, Math.min(ctx.maxParallel || 4, seg.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return out;
}

// ── 单个调用 ──
async function runOne(tc, { tools, onTool, onToolEnd, signal, effects, executionContext, replayPolicy, ordinal = 0 }) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
  const fnName = tc.function?.name || "";
  const logicalOrdinal = Number.isInteger(tc.__ordinal) ? tc.__ordinal : ordinal;
  const runId = executionContext?.runId;
  const turn = Number.isInteger(executionContext?.turn) ? executionContext.turn : 0;
  const effectKey = effects && runId ? canonicalStepKey(fnName, args, { turn, index: logicalOrdinal }) : null;
  const toolContext = {
    sessionId: executionContext?.sessionId,
    model: executionContext?.model,
    history: executionContext?.history,
    onEvent: executionContext?.onEvent,
    aibodyContext: executionContext?.aibodyContext,
    signal,
    runId,
    attempt: executionContext?.attempt,
    turn,
    ordinal: logicalOrdinal,
    effectKey,
    argsHash: hashArgs(args),
  };
  if (signal?.aborted) {
    const out = { text: ABORTED_MARKER, isError: true };
    if (onToolEnd) onToolEnd(tc.id, fnName, args, out);
    return { id: tc.id, name: fnName, args, out, effectKey, ordinal: logicalOrdinal };
  }
  let reservation = null;
  if (effects && runId && effectKey) {
    reservation = effects.begin(runId, effectKey, {
      toolName: fnName,
      argsHash: toolContext.argsHash,
      ordinal: logicalOrdinal,
      turn,
      attempt: executionContext?.attempt,
      replayPolicy: replayPolicy?.(fnName, args) || "never",
    });
    if (reservation.action === "reuse") {
      const out = { ...(reservation.result || { text: "（已完成，无可复用结果）" }), reused: true };
      if (onToolEnd) onToolEnd(tc.id, fnName, args, out, toolContext);
      return { id: tc.id, name: fnName, args, out, effectKey, ordinal: logicalOrdinal };
    }
    if (reservation.action === "blocked") {
      const out = {
        text: `[恢复暂停] 工具 ${fnName} 上次执行状态不确定（${reservation.reason}），未自动重试，请先确认外部状态。`,
        isError: true,
        uncertain: true,
      };
      if (onToolEnd) onToolEnd(tc.id, fnName, args, out, toolContext);
      return { id: tc.id, name: fnName, args, out, effectKey, ordinal: logicalOrdinal };
    }
  }
  if (onTool) onTool(tc.id, fnName, args, toolContext);
  let out;
  try {
    out = await (tools ? tools.execute(fnName, args, toolContext) : { text: `未知工具: ${fnName}`, isError: true });
  } catch (error) {
    effects?.markUncertain?.(runId, effectKey, String(error?.message || error));
    out = { text: `工具执行异常: ${String(error?.message || error)}`, isError: true, uncertain: true };
  }
  if (effects && runId && effectKey && !out?.uncertain) effects.complete(runId, effectKey, out);
  if (onToolEnd) onToolEnd(tc.id, fnName, args, out, toolContext);
  return { id: tc.id, name: fnName, args, out, effectKey, ordinal: logicalOrdinal };
}

function abortedResult(tc, ctx) {
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
  const fnName = tc.function?.name || "";
  const out = { text: ABORTED_MARKER, isError: true };
  if (ctx.onToolEnd) ctx.onToolEnd(tc.id, fnName, args, out);
  const logicalOrdinal = Number.isInteger(tc.__ordinal) ? tc.__ordinal : (Number.isInteger(ctx.ordinal) ? ctx.ordinal : 0);
  const runId = ctx.executionContext?.runId;
  const turn = Number.isInteger(ctx.executionContext?.turn) ? ctx.executionContext.turn : 0;
  const effectKey = ctx.effects && runId ? canonicalStepKey(fnName, args, { turn, index: logicalOrdinal }) : null;
  return { id: tc.id, name: fnName, args, out, effectKey, ordinal: logicalOrdinal };
}

// ── 排他判定：工具注册时 parallel:false → 屏障 ──
function isExclusive(tc, tools) {
  const name = tc.function?.name;
  if (!name || !tools?.getDef) return false;
  const def = tools.getDef(name);
  return def?.parallel === false;
}

export default scheduleToolCalls;
