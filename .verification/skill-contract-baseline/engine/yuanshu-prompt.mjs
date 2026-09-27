// 元枢 system 命名区段（dsh SystemPrompt sections：可单独替换、按序拼接）
import {
  YUANSHU_PROTOCOL,
  formatSkillIndexPrompt,
  matchSkillsForTask,
} from "./yuanshu-protocol.mjs";
import { shouldInjectFullMemory } from "./context-loader.mjs";
import { sessionContinuityNote } from "./yuanshu-session.mjs";

export const YUANSHU_SECTION_ORDER = [
  "persona", "protocol", "rules", "tools", "skills", "memory", "time", "runtime", "plan", "task",
];

function sectionText(raw) {
  if (Array.isArray(raw)) return raw.filter(Boolean).map((x) => String(x).trim()).filter(Boolean).join("\n\n");
  return String(raw || "").trim();
}

export function assemblePrompt(sections = {}, { order = YUANSHU_SECTION_ORDER } = {}) {
  const parts = [];
  for (const id of order) {
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

export function prependAssembledSystem(history = [], sections = {}) {
  const blob = assemblePrompt(sections);
  if (!blob) return history;
  return [{ role: "system", content: blob }, ...history];
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
} = {}) {
  const sections = {};
  if (persona) sections.persona = persona;
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
  if (shouldInjectFullMemory(message)) {
    const mem = [];
    if (Array.isArray(experience)) mem.push(...experience);
    if (Array.isArray(fullMemory)) mem.push(...fullMemory);
    if (mem.length) sections.memory = mem.join("\n\n");
  }
  if (time) sections.time = time;
  const run = [sessionContinuityNote(hist), todos, runtime].filter((x) => String(x || "").trim());
  if (run.length) sections.runtime = run.join("\n");
  if (task) sections.task = task;
  return sections;
}
