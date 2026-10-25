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
