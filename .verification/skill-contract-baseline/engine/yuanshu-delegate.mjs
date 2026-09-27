// OpenHands AgentDelegate 精简版：主循环可派 flash 子代理，只回收结论。
import { spawnSubagent } from "./subagent.mjs";
import { forkSeedFromHistory } from "./subagent-fork.mjs";

export const DELEGATE_TASK_TOOL = {
  type: "function",
  function: {
    name: "delegate_task",
    description: "把独立调研/对比/摘要派给廉价 flash 子代理。只回收 JSON 结论，不带回过程。不要用它写文件、跑命令或出视频。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "子任务：要做什么、输出什么结论" },
        context: { type: "array", items: { type: "string" }, description: "最小必要上下文，不要贴整段历史" },
        role: { type: "string", enum: ["analyst", "planner", "reviewer"], description: "有限职责标签，仅用于记录与路由" },
      },
      required: ["task"],
    },
  },
};

export async function execDelegateTask(args = {}, ctx = {}) {
  const task = String(args?.task || "").trim();
  if (!task) return { text: "delegate_task 需要 task", isError: true };
  const context = Array.isArray(args.context) ? args.context.map(String).slice(0, 8) : [];
  const r = await spawnSubagent({
    task,
    context,
    role: args.role || ctx.role || "analyst",
    // 关联身份和取消信号只能来自宿主执行上下文，不能由模型参数伪造。
    sessionId: ctx.sessionId || "",
    runId: ctx.runId || "",
    signal: ctx.signal,
    onEvent: ctx.onEvent,
    aibodyContext: ctx.aibodyContext,
    model: args.model || ctx.model,
    timeoutMs: args.timeoutMs || ctx.timeoutMs,
  });
  if (!r?.done) return { text: `子任务失败：${r?.error || "未知错误"}`, isError: true, subagentRunId: r?.subagentRunId, cancelled: r?.cancelled };
  const evidence = (r.evidence || []).slice(0, 6).join("；");
  return {
    text: `【子代理结论】${r.result}\n证据：${evidence || "无"}\n把握：${r.confidence}`,
    isError: false,
    subagentRunId: r.subagentRunId,
  };
}

// ── fork 型：继承本次对话已完成的前文（dsh-subagent-fork 的等价物）──
// 和 delegate_task 是两个工具、由模型自己选，而不是自动挑——这样"要不要把前文带过去"
// 是一个可见的决定（dsh 也是两条硬编码工具行，`dsh-base/cordis.patch.yml:349-367`）。
export const DELEGATE_FORK_TOOL = {
  type: "function",
  function: {
    name: "delegate_fork",
    description: "把任务派给一个**继承本次对话已有前文**的子代理：它已经看过前面聊过什么，不要你把背景重讲一遍。适合「接着上面说的继续核查 / 对比 / 收口」这类任务。只回收 JSON 结论，不带回过程。需要子代理完全独立、不受前文影响地判断时，请改用 delegate_task。不要用它写文件、跑命令或出视频。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "子任务：要做什么、输出什么结论" },
        context: { type: "array", items: { type: "string" }, description: "需要额外点明的、前文里没有的事实" },
        role: { type: "string", enum: ["analyst", "planner", "reviewer"], description: "有限职责标签，仅用于记录与路由" },
      },
      required: ["task"],
    },
  },
};

export async function execDelegateFork(args = {}, ctx = {}) {
  const task = String(args?.task || "").trim();
  if (!task) return { text: "delegate_fork 需要 task", isError: true };
  // 种子只能来自宿主传进来的历史——模型不能自己伪造"前文"。
  const seedInfo = forkSeedFromHistory(ctx.history || []);
  if (!seedInfo.messages.length) {
    return { text: "delegate_fork 没有可继承的前文（本会话还没完成过一轮对话）。请改用 delegate_task，并把必要背景写进 context", isError: true };
  }
  const r = await spawnSubagent({
    task,
    seed: seedInfo.messages,
    context: Array.isArray(args.context) ? args.context.map(String).slice(0, 8) : [],
    role: args.role || ctx.role || "analyst",
    sessionId: ctx.sessionId || "",
    runId: ctx.runId || "",
    signal: ctx.signal,
    onEvent: ctx.onEvent,
    aibodyContext: ctx.aibodyContext,
    model: args.model || ctx.model,
    timeoutMs: args.timeoutMs || ctx.timeoutMs,
    parentDepth: Number(ctx.depth) || 0,
  });
  if (!r?.done) return { text: `子任务失败：${r?.error || "未知错误"}`, isError: true, subagentRunId: r?.subagentRunId, cancelled: r?.cancelled };
  const evidence = (r.evidence || []).slice(0, 6).join("；");
  // 省略必须自报：把"继承了多少、漏了多少"写进回执，别让子代理以为前文里没有工具活动
  const note = seedInfo.droppedToolResults
    ? `（继承前文；其中 ${seedInfo.droppedToolResults} 条工具结果未带过去）`
    : "（继承前文）";
  return {
    text: `【子代理结论${note}】${r.result}\n证据：${evidence || "无"}\n把握：${r.confidence}`,
    isError: false,
    subagentRunId: r.subagentRunId,
  };
}
