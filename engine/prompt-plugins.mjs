// 引擎页「旁路插件」：网页写的提示词插件（2026-11-17）
// 以前面板只能挂「回声/时钟」两个空壳，挂上对主聊天毫无影响。
// 现在一个插件 = 一段文字 + 进哪一段（记忆/技能/计划）+ 可选触发词；
// 走的是主聊天本来就在收的 prompt-section 接缝，挂上后下一句对话生效。
// 网页只能交声明（名称/段落/文字/触发词），不能交代码；落盘在工作区，重启后挂回。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "./atomic-io.mjs";
import { SEAM_PROMPT } from "./yuanshu-seams.mjs";

export const PROMPT_PLUGINS_REL = path.join("记忆", "运行时", "旁路插件.json");
export const PROMPT_SECTIONS = { memory: "记忆", skills: "技能", plan: "计划" };
export const USER_PLUGIN_PREFIX = "user-prompt:";
const MAX_TEXT = 4000, MAX_NAME = 40, MAX_TRIGGERS = 10, MAX_TRIGGER = 20, MAX_PLUGINS = 30;

const fileOf = (wsRoot) => path.join(String(wsRoot || "."), PROMPT_PLUGINS_REL);

export function normalizePromptPlugin(body = {}) {
  if (body.mount !== undefined) throw new Error("网页不能传 mount 函数，只能写名称/段落/内容/触发词");
  const name = String(body.name || "").trim();
  if (!name || name.length > MAX_NAME) throw new Error(`名称必填，最多 ${MAX_NAME} 字`);
  const section = String(body.section || "").trim();
  if (!Object.hasOwn(PROMPT_SECTIONS, section)) throw new Error("段落只能是 记忆/技能/计划（memory/skills/plan）");
  const text = String(body.text || "").trim();
  if (!text || text.length > MAX_TEXT) throw new Error(`内容必填，最多 ${MAX_TEXT} 字`);
  const raw = Array.isArray(body.triggers) ? body.triggers : String(body.triggers || "").split(/[,，、\n]/);
  const triggers = [...new Set(raw.map((t) => String(t || "").trim()).filter((t) => t && t.length <= MAX_TRIGGER))].slice(0, MAX_TRIGGERS);
  const id = /^user-prompt:[a-f0-9]{8}$/.test(String(body.id || "")) ? String(body.id) : USER_PLUGIN_PREFIX + crypto.randomBytes(4).toString("hex");
  return { id, name, section, text, triggers, createdAt: Number(body.createdAt) || Date.now() };
}

export function readPromptPlugins(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(wsRoot), "utf8"));
    const out = [];
    for (const p of Array.isArray(raw?.plugins) ? raw.plugins : []) {
      try { out.push(normalizePromptPlugin(p)); } catch {}
    }
    return out;
  } catch { return []; }
}

function writeAll(wsRoot, plugins) {
  const file = fileOf(wsRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, { v: 1, plugins });
}

export function savePromptPlugin(wsRoot, body) {
  const p = normalizePromptPlugin({ ...body, id: undefined, createdAt: undefined });
  const all = readPromptPlugins(wsRoot);
  if (all.some((x) => x.name === p.name)) throw new Error(`已有同名插件「${p.name}」，换个名称或先卸掉`);
  if (all.length >= MAX_PLUGINS) throw new Error(`最多 ${MAX_PLUGINS} 个提示词插件`);
  writeAll(wsRoot, [...all, p]);
  return p;
}

export function removePromptPlugin(wsRoot, id) {
  const all = readPromptPlugins(wsRoot);
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) return false;
  writeAll(wsRoot, next);
  return true;
}

// 触发词为空 = 每句都带；否则这句话里出现任一触发词才带
export function promptPluginDef(p) {
  const hit = (message) => !p.triggers.length || p.triggers.some((t) => String(message || "").includes(t));
  return {
    id: p.id,
    name: p.name,
    version: "1",
    deps: [],
    mount: () => ({ seam: SEAM_PROMPT, section: p.section, contribute: (ctx) => (hit(ctx?.message) ? p.text : "") }),
  };
}

export async function loadPromptPlugins(registry, wsRoot) {
  let n = 0;
  for (const p of readPromptPlugins(wsRoot)) {
    try { await registry.load(promptPluginDef(p)); n++; } catch (e) { console.warn(`[engine] 提示词插件 ${p.name} 挂载失败：${e?.message || e}`); }
  }
  return n;
}
