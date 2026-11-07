// ===== run-title.mjs —— 给每一轮 run 一个「人读得懂的名字」（2026-11-07）=====
//
// 背景：看门狗已经能说「run f2170fcd（22:31 开始）· bash 连续失败 3 次」，
// 但伙伴仍然认不出这是哪件事——审计行里只有 runId，taskId 实测为空，
// 而 run 记录里从来没有一个给人看的任务名。
//
// 这里只做一件事：把各入口本来就有的信息，按优先级压成一行 ≤40 字的标题：
//   ① 显式 title（调用方已经想好名字）
//   ② 派活任务文本（去掉 markdown/换行/命令噪声，取前 30 字）
//   ③ 定时任务 label
//   ④ 子代理/值班 watch 的 name
//   ⑤ 用户消息首句（去掉「帮我/请/麻烦」这类前缀，截断）
//   ⑥ 兜底 `<surface> · <HH:mm>`（例如 微信 · 22:31）
//
// 约束：纯函数、无 I/O；唯一的「环境读取」是兜底标题的默认时钟（显式传 at 即可完全确定）。
export const RUN_TITLE_MAX = 40;   // 标题总长上限（中文字符按 1 个算）
const TASK_TEXT_MAX = 30;          // 派活任务文本只取前 30 字
const MESSAGE_TEXT_MAX = 30;       // 用户消息首句同样截断到 30 字
const SURFACE_TEXT_MAX = 12;       // 来源名（没见过的来源）最多留 12 字

/** 常见来源 → 人话。没命中的来源原样截断显示。 */
const SURFACE_NAMES = Object.freeze({
  wechat: "微信",
  wx: "微信",
  web: "网页",
  browser: "网页",
  ui: "网页",
  terminal: "终端",
  cli: "终端",
  shell: "终端",
  cron: "定时任务",
  time: "定时任务",
  scheduler: "定时任务",
  subagent: "子代理",
  watch: "值班",
  system: "系统",
});

const pad2 = (n) => String(n).padStart(2, "0");

/** 按字符（码点）截断，超长补省略号；上限至少为 1。 */
function clip(raw, max) {
  const chars = [...String(raw ?? "")];
  const limit = Math.max(1, Number(max) || 1);
  if (chars.length <= limit) return chars.join("");
  return chars.slice(0, limit - 1).join("") + "…";
}

/** 去掉 markdown 的结构符号，但保留正文（命令常写在代码围栏里）。 */
function stripMarkdown(raw) {
  return String(raw ?? "")
    // 围栏标记去掉、内容保留：```bash\nnpm test\n``` → npm test
    .replace(/```[^\n]*\n?/g, "")
    .replace(/```/g, "")
    // 图片/链接只留可读文字
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // 行内 HTML 标签
    .replace(/<[^>]{1,120}>/g, " ")
    // 行首的标题井号、引用符、列表符号（"- "、"1. " 等）
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, "")
    // 强调符号只去掉「成对包裹」的那层；下划线/波浪号保留——文件名和路径里很常见。
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    // 行内代码的反引号去掉，命令正文保留
    .replace(/`/g, "");
}

/** 去掉终端提示符与命令前缀：PS C:\x>、$、bash: 之类不说明在干什么。 */
function stripCommandNoise(line) {
  let s = String(line ?? "").trim();
  s = s.replace(/^(?:PS\s+[^>]{0,80}>|\([^)]{1,40}\)\s*PS[^>]{0,80}>|[A-Za-z]:\\[^>]{0,160}>|[$>#%]\s+)\s*/, "");
  s = s.replace(/^(?:bash|sh|zsh|pwsh|powershell|cmd|shell)\s*[:：]\s*/i, "");
  // "cd /d/x && npm test"：切目录只是噪声，真正要做的是后半句
  s = s.replace(/^(?:cd(?:\s+|\/d\s+)[^;&|\n]+?(?:&&|;)\s*)+/i, "");
  return s.trim();
}

/** 按行清洗并挑出有意义的行；只有 "cd ..." 的一行不说明在干什么，丢掉。 */
function meaningfulLines(raw) {
  const lines = stripMarkdown(raw)
    .split(/\r?\n/)
    .map((line) => stripCommandNoise(line))
    .filter(Boolean);
  while (lines.length > 1 && /^cd(?:\s|\/d)/i.test(lines[0])) lines.shift();
  return lines;
}

/** 压成一行：去行首协议标签（【…】）、合并空白。 */
function compact(raw) {
  const joined = meaningfulLines(raw).join(" ");
  return joined
    .replace(/^(?:【[^】]{1,24}】\s*)+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去掉「帮我/请/麻烦」这类客套前缀；用户消息首句才用。 */
function stripPoliteness(raw) {
  let s = String(raw ?? "");
  const re = /^(?:嗯+|那么|那|麻烦你|麻烦|请你|请帮我|请帮忙|请问|请教|请|帮我|帮忙|能不能|可以帮我|可以|能否)\s*/i;
  while (re.test(s)) s = s.replace(re, "");
  return s.trim();
}

/** 只取首句：复盘/需求常是一大段，标题不该把整段搬进去。 */
function firstSentence(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const hit = text.split(/[。！？!?；;\n]/).map((part) => part.trim()).find(Boolean);
  return hit || "";
}

/** 兜底时间：at 可以是毫秒、Date 或 ISO 字符串；缺省用当前时刻。 */
function clockOf(at) {
  const fallback = new Date();
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? fallback : at;
  if (typeof at === "string" && at.trim()) {
    const parsed = new Date(at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const ms = Number(at);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms);
  return fallback;
}

/** 来源 → 人话（微信/网页/终端/…）；认不出来的来源原样截断。 */
function surfaceName(surface) {
  const raw = compact(surface);
  if (!raw) return "任务";
  return SURFACE_NAMES[raw.toLowerCase()] || clip(raw, SURFACE_TEXT_MAX);
}

/** ⑥ 兜底：`微信 · 22:31`。 */
function fallbackTitle(surface, at) {
  const d = clockOf(at);
  return `${surfaceName(surface)} · ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 从各来源的可用信息推导一个 ≤40 字、人读得懂的 run 标题。
 * 六条优先级见文件头；任何一条为空就落到下一条，全空才用「来源 · 时间」兜底。
 *
 * @param {object} input
 * @param {string} [input.title]    显式标题（调用方已经想好名字）
 * @param {string} [input.task]     派活任务文本
 * @param {string} [input.label]    定时任务 label
 * @param {string} [input.name]     子代理/值班 watch 的 name
 * @param {string} [input.message]  用户消息
 * @param {string} [input.surface]  来源（wechat/web/terminal/…）
 * @param {number|Date|string} [input.at] 兜底标题里的时间，缺省为当前时刻
 * @returns {string}
 */
export function deriveRunTitle({ title, task, label, name, message, surface, at } = {}) {
  // ① 显式标题：调用方说得已经够清楚，不再加工
  const explicit = clip(compact(title), RUN_TITLE_MAX);
  if (explicit) return explicit;

  // ② 派活任务文本：去掉 markdown/换行/命令噪声，取前 30 字
  const dispatched = clip(compact(task), TASK_TEXT_MAX);
  if (dispatched) return dispatched;

  // ③ 定时任务 label
  const scheduled = clip(compact(label), RUN_TITLE_MAX);
  if (scheduled) return scheduled;

  // ④ 子代理/值班的 name
  const named = clip(compact(name), RUN_TITLE_MAX);
  if (named) return named;

  // ⑤ 用户消息首句：先去掉客套前缀，再截断
  const asked = clip(firstSentence(stripPoliteness(compact(message))), MESSAGE_TEXT_MAX);
  if (asked) return asked;

  // ⑥ 兜底：来源 · 时间
  return fallbackTitle(surface, at);
}
