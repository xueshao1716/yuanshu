// ===== persona-resolve.mjs —— 人格段的**唯一**解析点（2026-10-25）=====
//
// 抄自 dsh-persona-dafeiyu 的三条机制，不是抄它的数据模型（它是一堆纯文本人设，
// 元枢是"一个人 + 结构化定义 + 人批准"，数据模型不能照搬）：
//   ① 单点解析：显示与注入走同一个函数。此前 persona 段在 yuanshu-seams 里分三段拼
//      （定义 → 灵魂 → 自我），而 /api/persona 又自己渲染一遍——两边各拼各的，迟早漂移。
//   ② 越细越优先：会话 > 工作区（= 人格定义默认）。元枢一个进程只有一个工作区，
//      所以真正可加的是**会话档**：临时给某个会话一个语气档，不影响别的会话。
//   ③ 正文按需取：解析结果只带每段的 id/名称/字数，正文另接口取——人设段变长时
//      状态接口不会跟着胀。
//
// 与插件的关键区别（有意为之）：这里不提供"随便换一个人"的能力。人格定义仍是唯一真相、
// 改动仍要人批准（engine/persona-approval.mjs）；会话档只调**语气档位**，不改身份。
import fs from "node:fs";
import path from "node:path";
import { loadPersonaDefinition, renderPersonaSection } from "./persona-def.mjs";
import { soulContextPrompt } from "./soul-context.mjs";
import { buildSelfModel, renderSelfSection } from "./self-model.mjs";

export const SESSION_STYLE_FILE = path.join("记忆", "运行时", "会话语气.json");
/** 会话档是临时的：默认 7 天后自动失效，避免"很久以前随手设的档"一直粘着。 */
export const SESSION_STYLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 语气档会进系统提示词，必须短。超长直接拒绝，不静默截断（截断会让语义变形）。 */
export const MAX_STYLE_CHARS = 200;

/** 预设档位。也可以传任意短文本，但预设能让界面不必让用户凭空想。 */
export const STYLE_PRESETS = {
  concise: { label: "简洁", text: "本会话语气：短句直给，先结论后理由，不铺陈。" },
  companion: { label: "陪伴", text: "本会话语气：多问一句、多接一句情绪，像朋友聊天，少列条目。" },
  deep: { label: "深度", text: "本会话语气：先给判断和依据，再列取舍；该展开的展开，不为短而省关键推理。" },
};

function styleFile(wsRoot) { return path.join(String(wsRoot || "."), SESSION_STYLE_FILE); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** 读会话档（顺手按 TTL 清理过期项；只读不写回，写回交给 setSessionStyle）。 */
export function readSessionStyles(wsRoot, { now = Date.now() } = {}) {
  const raw = readJson(styleFile(wsRoot));
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [sid, v] of Object.entries(raw)) {
    if (!v || typeof v !== "object") continue;
    const at = Number(v.at) || 0;
    if (now - at > SESSION_STYLE_TTL_MS) continue;   // 过期的当作不存在
    const text = String(v.text || "").trim();
    if (!text) continue;
    out[sid] = { id: String(v.id || "custom"), label: String(v.label || "自定义"), text, at };
  }
  return out;
}

/**
 * 设置/清除某个会话的语气档。
 * @param {string|null} style 预设 id（concise/companion/deep）、任意短文本，或 null 表示清除
 */
export function setSessionStyle(wsRoot, sessionId, style, { now = Date.now() } = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "缺 sessionId" };
  const all = readSessionStyles(wsRoot, { now });   // 已按 TTL 过滤
  if (style == null || String(style).trim() === "") {
    delete all[sid];
    const pruned = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { id: v.id, label: v.label, text: v.text, at: v.at }]));
    try {
      const file = styleFile(wsRoot);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(pruned, null, 2), "utf8");
    } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
    return { ok: true, cleared: true };
  }
  const raw = String(style).trim();
  const preset = STYLE_PRESETS[raw];
  const text = preset ? preset.text : raw;
  const label = preset ? preset.label : "自定义";
  const id = preset ? raw : "custom";
  if (text.length > MAX_STYLE_CHARS) {
    return { ok: false, error: `语气档太长（${text.length} 字），上限 ${MAX_STYLE_CHARS} 字——它会进系统提示词` };
  }
  all[sid] = { id, label, text, at: now };
  const pruned = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { id: v.id, label: v.label, text: v.text, at: v.at }]));
  try {
    const file = styleFile(wsRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pruned, null, 2), "utf8");
    return { ok: true, style: { id, label, text, at: now } };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 120) }; }
}

export function sessionStyleFor(wsRoot, sessionId, { now = Date.now() } = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  return readSessionStyles(wsRoot, { now })[sid] || null;
}

/**
 * 拼出人格段的所有组成部分（顺序即注入顺序，最细的放最后——离指令越近越管用）。
 * 同时把 selfModel 一起带出来，调用方要落盘 `记忆/自我.md` 时不必再算一遍
 * （buildSelfModel 要扫会话文件，一轮算两次是白花）。
 * @returns {{parts:{id:string,label:string,text:string}[], selfModel:object|null}}
 */
export function personaParts({ wsRoot, sessionId = "", genes = null, model = null, now = Date.now() } = {}) {
  const parts = [];
  let selfModel = null;
  try {
    const { def } = loadPersonaDefinition(wsRoot);
    const text = renderPersonaSection(def, { genes, model });
    if (text) parts.push({ id: "definition", label: "人格定义", text });
  } catch {}
  try {
    const soul = soulContextPrompt(wsRoot);
    if (soul) parts.push({ id: "soul", label: "内心与关系", text: soul });
  } catch {}
  try {
    selfModel = buildSelfModel({ wsRoot });
    const selfSection = renderSelfSection(selfModel);
    if (selfSection) parts.push({ id: "self", label: "我是谁（活体自述）", text: selfSection });
  } catch { selfModel = null; }
  const style = sessionStyleFor(wsRoot, sessionId, { now });
  if (style) parts.push({ id: "session", label: `会话语气 · ${style.label}`, text: style.text });
  return { parts, selfModel };
}

/**
 * 唯一解析入口：注入用 `.section`，界面用 `.parts` 的元数据（去掉 text）+ `.meta`。
 * 显示与注入同源，所以"面板里看到的"和"真正拼进提示词的"不可能对不上。
 */
export function resolvePersona({ wsRoot, sessionId = "", genes = null, model = null, now = Date.now() } = {}) {
  const { parts, selfModel } = personaParts({ wsRoot, sessionId, genes, model, now });
  const section = parts.map((p) => p.text).filter(Boolean).join("\n\n");
  const style = sessionStyleFor(wsRoot, sessionId, { now });
  return {
    mode: style ? "session" : "workspace",
    sessionId: sessionId ? String(sessionId) : null,
    sessionStyle: style ? { id: style.id, label: style.label, at: style.at } : null,
    chars: section.length,
    // parts 带正文（注入方要）；给界面的元数据用 personaMeta() 压掉 text
    parts,
    section,
    selfModel,   // 调用方要写 记忆/自我.md 时直接用，别重算
  };
}

/** 给界面/接口的元数据：只留 id / 名称 / 字数，正文按需取。 */
export function personaMeta(resolution) {
  const r = resolution || {};
  return {
    mode: r.mode || "workspace",
    sessionId: r.sessionId || null,
    sessionStyle: r.sessionStyle || null,
    chars: Number(r.chars) || 0,
    parts: (r.parts || []).map((p) => ({ id: p.id, label: p.label, chars: p.text.length })),
  };
}

/** 按需取单段正文（界面「查看全文」用）。找不到返回 null。 */
export function personaPartText({ wsRoot, sessionId = "", id, genes = null, model = null, now = Date.now() } = {}) {
  const want = String(id || "").trim();
  if (!want) return null;
  const { parts } = personaParts({ wsRoot, sessionId, genes, model, now });
  const hit = parts.find((p) => p.id === want);
  return hit ? { id: hit.id, label: hit.label, chars: hit.text.length, text: hit.text } : null;
}
