// ===== subagent-fork.mjs —— fork 型子智能体（借 dsh-subagent-fork-in-process）=====
//
// 元枢原先只有 spawn 型子智能体（`delegate_task`）：干净上下文 + 自包含 prompt。
// dsh 的 fork 变体只差一个 seed —— 取父会话日志里**已完成**的那段前缀作为子智能体的
// 起始对话。差别不是"多一点上下文"，而是：
//   spawn 子智能体要你把它该知道的全写进 prompt（写漏就答歪）
//   fork  子智能体已经看过前面聊了什么（省掉重复总结，也少一处"总结失真"）
//
// 两条来自 dsh 的硬规矩：
//   ① **只取已完成的前缀**。dsh 是 `events.slice(0, lastEnd.seq + 1)`，最后一个
//      `turn/end` 之后的一律不要——在飞的回合重放会得到半截状态。这里等价地取
//      "最后一条有正文的助手消息"为止，其后的（工具调用/结果/本轮用户消息）全丢。
//   ② **深度只能加深，不能降低**（dsh `subagent/types/depth.js:18-25` 取
//      `max(持久化, 运行期)`）。否则一个被恢复的子智能体会从 0 重算深度，
//      绕过 maxDepth 限制无限派下去。
//
// 与 dsh 的一处刻意分歧：**工具结果不进 seed，但要说出来**。dsh 的 fork 继承完整
// 前缀（它的日志本来就是事件流）；元枢的历史里工具结果可能很大，全带过去会把子智能体
// 的预算吃光。所以这里丢弃工具结果，但**插一条明确的省略标记**——不然子智能体会
// 以为"前面没发生过工具调用"，那是"没被观测的说法"。省略必须自报。
import { nextSubagentDepth } from "./subagent-depth.mjs";

export { nextSubagentDepth };

const clip = (s, n) => { const t = String(s || ""); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}${n > 0 ? '…' : ''}` : t; };
const bound = (n, fallback) => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;

/** 从元枢的历史里取一条消息的文本（兼容 formatSessionHistory 与内部 hist 两种形状）。 */
function textOf(m) {
  if (!m || typeof m !== "object") return "";
  if (typeof m.content === "string") return m.content;
  if (m.content !== undefined && m.content !== null && typeof m.content !== "object") return String(m.content);
  return String(m.text || "");
}
const isToolMsg = (m) => m?.role === "tool" || m?.role === "toolResult";
const hasToolCalls = (m) => Array.isArray(m?.tool_calls) && m.tool_calls.length > 0;

/**
 * 取出父对话里**已完成**的那段，压成子智能体的起始消息。
 * @returns {{messages: Array<{role:string,content:string}>, droppedToolResults:number, truncated:boolean}}
 */
export function forkSeedFromHistory(history = [], { maxMessages = 12, maxChars = 6000, perMessageChars = 800 } = {}) {
  maxMessages = bound(maxMessages, 12);
  maxChars = bound(maxChars, 6000);
  perMessageChars = bound(perMessageChars, 800);
  const list = Array.isArray(history) ? history.filter((m) => m && typeof m === "object") : [];
  // 规矩①：从尾部往回找到最后一条"有正文的助手消息"，其后的全部丢掉（在飞的回合不要）
  let end = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "assistant" && !hasToolCalls(list[i]) && textOf(list[i]).trim()) { end = i; break; }
  }
  if (end < 0) return { messages: [], droppedToolResults: 0, truncated: false };
  const prefix = list.slice(0, end + 1);

  // 只保留 user / assistant 的正文；工具结果计数后丢弃（分歧点：丢弃必须自报）
  const kept = [];
  let droppedToolResults = 0;
  let clipped = false;
  for (const m of prefix) {
    if (isToolMsg(m)) { droppedToolResults++; continue; }
    if (m.role !== "user" && m.role !== "assistant") continue;
    const t = textOf(m).trim();
    if (!t) continue;
    if (t.length > perMessageChars) clipped = true;
    kept.push({ role: m.role, content: clip(t, perMessageChars) });
  }

  // 预算从**最近**往回取，保证子智能体记得的是刚发生的事
  const candidates = maxMessages > 0 ? kept.slice(-maxMessages) : [];
  const truncated = droppedToolResults > 0 || clipped || candidates.length < kept.length ||
    candidates.reduce((n, m) => n + m.content.length, 0) > maxChars;
  // maxMessages bounds historical messages; one metadata notice may be added.
  // Reserve that notice BEFORE choosing history, including the last long message.
  const note = truncated ? clip(droppedToolResults > 0
    ? `（继承前文有省略：${droppedToolResults} 条工具结果没有带过来；不要假设它没发生过。材料不足请主代理补充。）`
    : '（继承前文因预算有省略；材料不足请主代理补充。）', maxChars) : '';
  let remaining = maxChars - note.length;
  const picked = [];
  for (let i = candidates.length - 1; i >= 0 && remaining > 0; i--) {
    const content = clip(candidates[i].content, remaining);
    if (content) picked.unshift({ ...candidates[i], content });
    remaining -= content.length;
  }
  if (note) picked.unshift({ role: 'user', content: note });
  return { messages: picked, droppedToolResults, truncated };
}
