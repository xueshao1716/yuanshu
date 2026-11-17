// engine/subagent-progress.mjs —— 子代理进度存档（2026-11-17，学 Hermes 可恢复子代理）
//
// 后台子代理每做完一轮工具调用，就把"任务之后的那段对话"（assistant 的工具调用 + 工具结果）
// 存一份到 记忆/运行时/子代理进度/<id>.json。宿主重启/被打断/等人拍板之后续上，
// 把这段接回任务后面，它就从中断处接着干，而不是从头再查一遍。
//
// 存的是**消息**，不是摘要：续上时模型看到的就是自己当时查到的原文。
// 体积靠三条约束兜住：单条截断、总条数上限（按整轮丢最旧的）、没回答完的尾轮直接丢。
import fs from "node:fs";
import path from "node:path";

export const MAX_PROGRESS_CONTENT = 4000;
export const MAX_PROGRESS_MESSAGES = 40;

const SAFE_ID = /^[\w.-]{1,160}$/;

export function progressDir(wsRoot) {
  return path.join(String(wsRoot || "."), "记忆", "运行时", "子代理进度");
}

function fileFor(wsRoot, id) {
  const key = String(id || "");
  if (!SAFE_ID.test(key) || key.includes("..")) return "";
  return path.join(progressDir(wsRoot), `${key}.json`);
}

function clipMessage(message) {
  // anthropic_content 是原生通道的回放字段，体积大且续上时用不到
  const { anthropic_content, anthropic_model, ...rest } = message || {};
  if (typeof rest.content === "string" && rest.content.length > MAX_PROGRESS_CONTENT) {
    rest.content = `${rest.content.slice(0, MAX_PROGRESS_CONTENT - 20)}\n…（存档时截断）`;
  }
  return rest;
}

/** 按"轮"分组：一条非 tool 消息开一组，紧跟的 tool 结果归它。 */
function groupRounds(messages) {
  const groups = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool" && groups.length) groups.at(-1).push(message);
    else if (message.role !== "tool") groups.push([message]);
  }
  return groups;
}

function answered(group) {
  const calls = Array.isArray(group[0]?.tool_calls) ? group[0].tool_calls : [];
  if (!calls.length) return true;
  const done = new Set(group.slice(1).map((m) => m.tool_call_id));
  return calls.every((call) => done.has(call.id));
}

export function trimProgress(messages, { maxMessages = MAX_PROGRESS_MESSAGES } = {}) {
  const groups = groupRounds(Array.isArray(messages) ? messages : []);
  while (groups.length && !answered(groups.at(-1))) groups.pop();
  let total = groups.reduce((sum, group) => sum + group.length, 0);
  while (groups.length > 1 && total > maxMessages) total -= groups.shift().length;
  return groups.flat().map(clipMessage);
}

export function countSteps(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "assistant" && m.tool_calls?.length).length;
}

export function saveProgress(wsRoot, id, messages) {
  const file = fileFor(wsRoot, id);
  if (!file) return { ok: false, steps: 0 };
  const kept = trimProgress(messages);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id, savedAt: new Date().toISOString(), messages: kept }));
    fs.renameSync(tmp, file);
    return { ok: true, steps: countSteps(kept) };
  } catch (error) {
    return { ok: false, steps: 0, error: String(error?.message || error) };
  }
}

export function readProgress(wsRoot, id) {
  const file = fileFor(wsRoot, id);
  if (!file) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data?.messages) ? data.messages : [];
  } catch { return []; }
}

export function removeProgress(wsRoot, id) {
  const file = fileFor(wsRoot, id);
  if (file) try { fs.rmSync(file, { force: true }); } catch { /* 删不掉下次覆盖 */ }
}
