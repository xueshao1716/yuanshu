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
  "persona", "environment", "protocol", "guardrails", "rules", "tools", "skills", "memory", "taste", "time", "todos", "runtime", "plan", "task",
];

// 2026-11-13：这些区段是**当下状态**（待办/工作记忆/运行态），每轮都可能变，不能留在 system 里。
// 从 system 摘出的只有这三个；人格/规矩/工具规则仍在 system 原位。
export const TAIL_STATE_SECTIONS = new Set(["todos", "runtime", "plan"]);

function sectionText(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join("\n\n");
  return String(raw || "").trim();
}

export function assemblePrompt(sections = {}, { order = YUANSHU_SECTION_ORDER, includeTime = true, includeState = true } = {}) {
  const parts = [];
  for (const id of order) {
    // 2026-11-13：默认把 time 段从 system 里摘掉，改由 prependAssembledSystem 贴到本轮 user 末尾。
    // 摘除放在"组装真实请求"这一步，而不是改 assemblePrompt 的默认行为：
    // 预览/评测（assemblePrompt 的直接调用方）与回退档看到的仍是同一份区段顺序。
    if (id === "time" && !includeTime) continue;
    // 同上：待办/计划/运行态搬去末尾，system 只留逐字节稳定的规矩。
    if (!includeState && TAIL_STATE_SECTIONS.has(id)) continue;
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

// ── 易变状态搬到本轮 user 末尾（2026-11-13，省钱）────────────────────────────
// 起因：system 里带「当前时间：YYYY-MM-DD HH:MM」+「距上次对话 N 分钟」，同一会话隔一分钟
// 生成的 system 就变了 → prompt_cache_key 每轮换一个、服务端前缀缓存从变动处之后全部作废，
// 2 万 token 的固定系统提示每轮全价重算。
// 现在：system 只留**逐字节稳定**的区段（人格定义/红线/工具规则/行为准则 = 规矩），
// 时间、情绪、关系、人格漂移、成长、反模式、复习、做对过、待办、计划 = 当下状态，
// 全部贴到**最后一轮 user 消息末尾**（模型一样看得到，且前缀逐字节不变）。
// 回退：YUANSHU_TIME_IN_USER=0（时间）、YUANSHU_STATE_IN_TAIL=0（状态/情绪）恢复旧行为。
// 说明：必须**调用时**读环境变量（不是模块加载时），否则测试和热回退都不生效。
export function timeInUserEnabled(env = process.env) {
  return String(env?.YUANSHU_TIME_IN_USER ?? "").trim() !== "0";
}

export function stateInTailEnabled(env = process.env) {
  return String(env?.YUANSHU_STATE_IN_TAIL ?? "").trim() !== "0";
}

// 末尾状态段上限：一条消息里最多这么多个字（含表头）。超了按行截断，宁短勿长。
export const TAIL_STATE_HEADER = "【本轮状态】";
export const TAIL_STATE_MAX_CHARS = 600;

// 「（仅本轮）」：时间是**这一轮**的读数，不是可以带进摘要/下文的设定。
// 不加这一笔，模型和摘要器都会把几小时前的时间戳当成"现在"。
export const TIME_ONCE_MARK = "（仅本轮）";

export function markTimeNoteOnce(note = "") {
  const text = String(note || "").trim();
  if (!text || text.includes(TIME_ONCE_MARK)) return text;
  const [head, ...rest] = text.split("\n");
  return [`${head}${TIME_ONCE_MARK}`, ...rest].join("\n");
}

/**
 * 把一段文案贴到**最后一轮 user 消息**的末尾；没有 user 消息就原样返回。
 * 返回新数组/新消息对象，不改调用方传进来的内容（会话落库用的是原始 message，见 persistUser）。
 */
export function appendToLastUser(messages = [], text = "") {
  const body = String(text || "").trim();
  if (!body) return messages;
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
    if (last && last.type === "text" && typeof last.text === "string") parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${body}` };
    else parts.push({ type: "text", text: body });
    list[idx] = { ...msg, content: parts };
  } else {
    const prev = typeof content === "string" ? content : String(content ?? "");
    list[idx] = { ...msg, content: prev ? `${prev}\n\n${body}` : body };
  }
  return list;
}

export function appendTimeNoteToLastUser(messages = [], note = "") {
  return appendToLastUser(messages, markTimeNoteOnce(note));
}

// ── 状态段的形状 ─────────────────────────────────────────────────────────────
// 只留"当下状态"，一条一行、能砍就砍：待办只列前 3 条，计划/运行态各自限长。
// system 里没有这些内容了，模型判断"现在该干什么"全靠这一段——所以它必须**短而准**。
function oneLine(raw, max = 0) {
  let text = String(raw || "").replace(/\s+/g, " ").trim();
  if (max > 0 && text.length > max) text = `${text.slice(0, Math.max(0, max - 1))}…`;
  return text;
}

const TODO_ITEM_RE = /^\s*\d+[.、]\s*\[[ x>]\]\s*(.+)$/;

/** 待办清单（formatTodoPrompt 的多行格式）→ 一行。只列前 3 条，更多只报总数。 */
export function compactTodoLine(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(TODO_ITEM_RE);
    if (m) items.push(oneLine(m[1], 40));
  }
  if (!items.length) return "";
  const shown = items.slice(0, 3);
  const more = items.length > shown.length;
  return `待办：${shown.join("、")}${more ? ` 等 ${items.length} 条` : ""}`;
}

/** 磁盘工作记忆（formatPlanPrompt 的多行 markdown）→ 一行。 */
export function compactPlanLine(raw = "", max = 200) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const body = text
    .replace(/^【[^】]*】[^\n]*\n?/, "")
    .replace(/###\s*task_plan/g, "｜")
    .replace(/###\s*findings/g, "｜发现 ")
    .replace(/###\s*progress/g, "｜进展 ")
    .replace(/^[｜\s]+/, "");
  const line = oneLine(body, max);
  return line ? `计划：${line}` : "";
}

/** 运行态（会话续接 + AIBody 策略等）→ 一行。 */
export function compactRuntimeLine(raw = "", max = 160) {
  const line = oneLine(String(raw || "").replace(/^【[^】]*】\s*/, ""), max);
  return line ? `运行时：${line}` : "";
}

/** 从 sections 里取「待办/计划/运行态」这几段，压成状态正文（不含表头）。 */
export function stateSegmentsFrom(sections = {}) {
  return [
    compactTodoLine(sections?.todos),
    compactPlanLine(sections?.plan),
    compactRuntimeLine(sections?.runtime),
  ].filter(Boolean);
}

// 正文按行截断到预算内（末尾补一个省略号）。预算太小（连一个省略号都放不下）就整段不要。
function truncateBody(text = "", budget = 0) {
  const body = String(text || "").trim();
  if (budget <= 2) return "";
  if (body.length <= budget) return body;
  const cut = body.slice(0, budget - 1);
  const at = cut.lastIndexOf("\n");
  const kept = at > budget / 2 ? cut.slice(0, at) : cut;
  return `${kept}…`;
}

// 正文预算 = 总上限 − 表头 − 换行。
function clampStateBody(body = "", max = TAIL_STATE_MAX_CHARS) {
  return truncateBody(body, Math.max(0, max - TAIL_STATE_HEADER.length - 1));
}

/**
 * 把状态正文贴到末尾；本轮已经贴过（先待办/计划、后情绪）就**合并进同一块**，
 * 不再另起一段——模型看到的永远是「一段」状态，而不是几条散消息。
 * 合并时**先保已有的**（待办/计划是能干活的那部分），让后到的段落先让预算。
 * 返回新数组；没有 user 消息时原样返回（调用方自己决定要不要退回 system）。
 */
export function appendStateNoteToLastUser(messages = [], text = "", { max = TAIL_STATE_MAX_CHARS } = {}) {
  const body = String(text || "").trim();
  if (!body) return messages;
  const list = Array.isArray(messages) ? messages.slice() : [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === "user") { idx = i; break; }
  }
  if (idx < 0) return list;
  const msg = list[idx];
  if (Array.isArray(msg.content)) {
    // 多模态消息不做块内合并：补一个完整的状态块（罕见路径，宁可多一段也不拆内容块）
    const note = `${TAIL_STATE_HEADER}\n${clampStateBody(body, max)}`;
    return appendToLastUser(list, note);
  }
  const content = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
  // 只认"行首"的表头：用户自己粘进来的同名字符串不该被当成我们贴的状态块拆掉。
  const at = content.lastIndexOf(TAIL_STATE_HEADER);
  const markerAt = at >= 0 && (at === 0 || content[at - 1] === "\n") ? at : -1;
  const before = markerAt >= 0 ? content.slice(0, markerAt) : content;
  const existing = markerAt >= 0 ? content.slice(markerAt + TAIL_STATE_HEADER.length).replace(/^\n/, "") : "";
  const budget = Math.max(0, max - TAIL_STATE_HEADER.length - 1);
  const keptExisting = truncateBody(existing, budget);
  const room = keptExisting ? Math.max(0, budget - keptExisting.length - 1) : budget;
  const incoming = truncateBody(body, room);
  const merged = [incoming, keptExisting].filter(Boolean).join("\n");
  if (!merged) return list;   // 一点预算都没有：宁可不贴，也不贴个空表头
  const block = `${TAIL_STATE_HEADER}\n${merged}`;
  const joiner = before && !before.endsWith("\n") ? "\n\n" : "";
  list[idx] = { ...msg, content: `${before}${joiner}${block}` };
  return list;
}

export function prependAssembledSystem(history = [], sections = {}, { timeInUser = timeInUserEnabled(), stateInTail = stateInTailEnabled() } = {}) {
  // 只有 assembleYuanshuSystem 给得出「末尾文案」（timeNote）时才搬：手工传一个 time 段的调用方
  // （预览/评测/第三方接缝）仍按旧位置插 system，行为不变。
  const note = String(sections?.timeNote || "").trim();
  // 有 user 消息才搬得动；没有就留在 system（宁可按旧位置，也不把状态丢掉）。
  const canTail = history.some((m) => m?.role === "user");
  const moveTime = timeInUser && note !== "" && canTail;
  const stateText = stateInTail ? stateSegmentsFrom(sections).join("\n") : "";
  const moveState = stateText !== "" && canTail;
  const blob = assemblePrompt(sections, { includeTime: !moveTime, includeState: !moveState });
  let out = blob ? [{ role: "system", content: blob }, ...history] : history;
  if (moveTime) out = appendTimeNoteToLastUser(out, note);
  if (moveState) out = appendStateNoteToLastUser(out, stateText);
  return out;
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
  // 2026-11-13：待办单独成段（不再并进 runtime）——末尾注入时它要压成一行，
  // 和「会话续接/运行态」混在一段里就压不干净。
  if (String(todos || "").trim()) sections.todos = todos;
  const run = [sessionContinuityNote(hist), runtime].filter((x) => String(x || "").trim());
  if (run.length) sections.runtime = run.join("\n");
  if (task) sections.task = task;
  return sections;
}
