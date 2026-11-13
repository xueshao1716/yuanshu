// 元枢 system 命名区段（dsh SystemPrompt sections：可单独替换、按序拼接）
import {
  YUANSHU_PROTOCOL,
  formatSkillIndexPrompt,
  matchSkillsForTask,
} from "./yuanshu-protocol.mjs";
import { environmentSection } from './runtime-env.mjs';import { shouldInjectFullMemory } from "./context-loader.mjs";
import { sessionContinuityNote } from "./yuanshu-session.mjs";

export const YUANSHU_SECTION_ORDER = [
  // 2026-10-20：guardrails 紧跟 protocol —— 硬边界要在工作协议之后、具体工具之前出现
  // 2026-10-24：environment 紧跟 persona——先讲清"你在什么系统上、用什么符号"，再讲协议
  "persona", "environment", "protocol", "guardrails", "rules", "tools", "skills", "memory", "taste", "time", "runtime", "plan", "task",
];

function sectionText(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join("\n\n");
  return String(raw || "").trim();
}

export function assemblePrompt(sections = {}, { order = YUANSHU_SECTION_ORDER, includeTime = true } = {}) {
  const parts = [];
  for (const id of order) {
    // 2026-11-13：默认把 time 段从 system 里摘掉，改由 prependAssembledSystem 贴到本轮 user 末尾。
    // 摘除放在"组装真实请求"这一步，而不是改 assemblePrompt 的默认行为：
    // 预览/评测（assemblePrompt 的直接调用方）与回退档看到的仍是同一份区段顺序。
    if (id === "time" && !includeTime) continue;
    const text = sectionText(sections[id]);
    if (!text) continue;
    parts.push(`### section:${id}\n${text}`);
  }
  return parts.join("\n\n");
}

export function replaceSection(sections = {}, id, body) {
  return { ...sections, [id]: body };
}

export function projectRuntime(prev, next) {
  const snapshot = String(next ?? "");
  return { snapshot, changed: snapshot !== String(prev ?? "") };
}

// ── 时间上下文搬到本轮 user 末尾（2026-11-13，省钱）──────────────────────────
// 起因：system 里带「当前时间：YYYY-MM-DD HH:MM」+「距上次对话 N 分钟」，同一会话隔一分钟
// 生成的 system 就变了 → prompt_cache_key 每轮换一个、服务端前缀缓存从变动处之后全部作废，
// 2 万 token 的固定系统提示每轮全价重算。
// 现在：system 只留**逐字节稳定**的区段，时间贴到最后一轮 user 消息的末尾（模型一样看得到）。
// 回退：YUANSHU_TIME_IN_USER=0 → 恢复旧行为（时间留在 system 的原位置）。
// 说明：必须**调用时**读环境变量（不是模块加载时），否则测试和热回退都不生效。
export function timeInUserEnabled(env = process.env) {
  return String(env?.YUANSHU_TIME_IN_USER ?? "").trim() !== "0";
}

/**
 * 把时间文案贴到**最后一轮 user 消息**的末尾；没有 user 消息就原样返回。
 * 返回新数组/新消息对象，不改调用方传进来的内容（会话落库用的是原始 message，见 persistUser）。
 */
export function appendTimeNoteToLastUser(messages = [], note = "") {
  const text = String(note || "").trim();
  if (!text) return messages;
  const list = Array.isArray(messages) ? messages.slice() : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === "user") { idx = i; break; }
  }
  // 没有 user 消息就不硬造一条：多出一条空 user 会被部分网关当非法轮次
  if (idx < 0) return list;
  const msg = list[idx];
  const content = msg.content;
  if (Array.isArray(content)) {
    // 多模态消息：贴在最后一个 text 块后面；末尾不是 text 就补一个 text 块
    const parts = content.slice();
    const last = parts[parts.length - 1];
    if (last && last.type === "text" && typeof last.text === "string") parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
    else parts.push({ type: "text", text });
    list[idx] = { ...msg, content: parts };
  } else {
    const prev = typeof content === "string" ? content : String(content ?? "");
    list[idx] = { ...msg, content: prev ? `${prev}\n\n${text}` : text };
  }
  return list;
}

export function prependAssembledSystem(history = [], sections = {}, { timeInUser = timeInUserEnabled() } = {}) {
  // 只有 assembleYuanshuSystem 给得出「末尾文案」（timeNote）时才搬：手工传一个 time 段的调用方
  // （预览/评测/第三方接缝）仍按旧位置插 system，行为不变。
  const note = String(sections?.timeNote || "").trim();
  const moveTime = timeInUser && note !== "";
  const blob = assemblePrompt(sections, { includeTime: !moveTime });
  const out = blob ? [{ role: "system", content: blob }, ...history] : history;
  return moveTime ? appendTimeNoteToLastUser(out, note) : out;
}

export function buildYuanshuSections({
  message = "",
  skills = [],
  experience = [],
  fullMemory = [],
  todos = "",
  hist = [],
  persona = "",
  time = "",
  rules = "",
  tools = "",
  task = "",
  runtime = "",
  taste = "",
  goldFacts = "",
} = {}) {
  const sections = {};
  if (persona) sections.persona = persona;
  // 2026-10-24：环境事实常驻，避免模型把 /d/x 与 D:\x、bash 与 cmd 混用
  try { sections.environment = environmentSection(); } catch {}
  sections.protocol = YUANSHU_PROTOCOL;
  if (rules) sections.rules = Array.isArray(rules) ? rules.join("\n") : rules;
  if (tools) sections.tools = tools;
  const skillParts = [];
  const skillText = formatSkillIndexPrompt(skills);
  if (skillText) skillParts.push(skillText);
  const matched = matchSkillsForTask(message, skills);
  if (matched.length) {
    skillParts.push(`本轮任务可能匹配技能：${matched.map((s) => s.name).join("、")}。对得上就 activate_skill，对不上按你的判断继续。`);
    if (/ppt|幻灯片|演示|汇报/i.test(String(message || "")) && matched.some((s) => /ppt|presentation|幻灯片|演示/i.test(s.name))) {
      skillParts.push("PPT 交付指令：这是直接交付任务，采用技能的快速生成流程，跳过可选的大纲确认，继续填充内容并生成可下载的 .pptx；生成失败要分段修复后重试并汇报实际错误。");
    }
  }
  if (skillParts.length) sections.skills = skillParts.join("\n");
  if (taste) sections.taste = taste;
  // 2026-10-24：黄金事实不受 shouldInjectFullMemory 闸门约束——闲聊也要带上，
  // 否则"我刚问你装在哪"这种短句会因为不含动作词而丢事实，模型只能反问一遍。
  const memParts = [];
  const gold = String(goldFacts || "").trim();
  if (gold) memParts.push(gold);
  if (shouldInjectFullMemory(message)) {
    if (Array.isArray(experience)) memParts.push(...experience.filter(Boolean));
    if (Array.isArray(fullMemory)) memParts.push(...fullMemory.filter(Boolean));
  }
  if (memParts.length) sections.memory = memParts.join("\n\n");
  if (time) sections.time = time;
  const run = [sessionContinuityNote(hist), todos, runtime].filter((x) => String(x || "").trim());
  if (run.length) sections.runtime = run.join("\n");
  if (task) sections.task = task;
  return sections;
}
