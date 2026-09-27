// 工坊提示词智能填充：一句话 → 可拍/可出片的成稿。模型失败则规则兜底。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "./http-utils.mjs";
import { fillHtmlBrief, formatHtmlBriefBlock } from "./workshop-html-brief.mjs";
import { pickExpandModel } from "./workshop-model.mjs";
import { fallbackVideoExpand } from "./workshop-video-fallback.mjs";

const IMAGE_HINT = `你是出图提示词编辑。把用户一句话扩成可直接送给即梦/Seedream 的中文画面描述。
只输出 JSON：{"prompt":"...","fields":{"look":"","outfit":"","pose":"","expression":"","bg":"","lighting":"","style":""}}
硬约束：按所附技能写要素（主体/服饰/构图/光影/风格）；保留用户点名的主体与事实；写成可拍的句子，不要顿号标签堆；单一主画面；不要字幕水印伪文字；不要紫蓝渐变套话。不要反问。`;

const VIDEO_HINT = `你是短视频镜头提示词编辑。把用户一句话扩成可直接送给 Seedance/即梦视频 的镜头卡。
只输出 JSON：{"prompt":"...","fields":{"subject":"","action":"","scene":"","lighting":"","camera":"","style":"","memory":""}}
prompt 必须含【总览】【记忆点】【时间轴】【物理】【锁定】【规格】，时间轴写 0-2/2-5/5-8/8-10 四拍，物理写运动/环境/材质/光学。
硬约束：必须写出具体的人、服装料子、动作、地点，禁止把用户原句原样贴进总览和记忆点；不要字幕 BGM；一次一个主要运镜。
若用户要对话、对谈、采访、口播、短剧对白：写口型，用过肩或正反打；不要烧录字幕；对谈只这两个人，禁止写「无多余人物」把对方删掉。不要反问。`;

const HTML_HINT = `你是 HTML 设计稿 brief 编辑。把用户一句话扩成可检查的六项约束。
只输出 JSON：{"prompt":"...","fields":{"scope":"","structure":"","material":"","verb":"","stack":"","accept":""}}
verb 必须是 2–8 个汉字，整套只准这一个动作（如揭示/对照/递进），并写进 prompt。
技术栈固定为自包含 HTML、零 CDN，禁止 React/Tailwind/Inter 外链。不要反问。`;

export const EXPAND_SKILLS = {
  image: ["wanxiang-portrait", "wanxiang-design"],
  video: ["seedance-25", "shortform-genesis"],
  html: [],
};

const SKILL_EACH = 700;
const SKILL_TOTAL = 1800;
const EXPAND_MAX_TOKENS = 1600;
export const EXPAND_CHAT_MS = 12_000;

export function parseExpandJson(text) {
  const raw = String(text || "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const prompt = String(obj.prompt || obj.text || "").trim();
    if (!prompt) return null;
    const fields = obj.fields && typeof obj.fields === "object" && !Array.isArray(obj.fields) ? obj.fields : {};
    const clean = {};
    for (const [k, v] of Object.entries(fields)) {
      const s = String(v ?? "").trim();
      if (s) clean[k] = s;
    }
    return { prompt, fields: clean };
  } catch {
    return null;
  }
}

export function fallbackExpand(kind, idea) {
  const s = String(idea || "").trim();
  if (kind === "html" || kind === "ppt") {
    const fields = fillHtmlBrief({ theme: s });
    return { prompt: `${s}\n\n${formatHtmlBriefBlock(fields)}`, fields, source: "fallback" };
  }
  if (kind === "video") return fallbackVideoExpand(s);
  return {
    prompt: `${s}。单一主画面，主体完整，光线有方向，写实可拍。不要字幕、水印、多余肢体或畸形手指。`,
    fields: { look: s },
    source: "fallback",
  };
}

function hintFor(kind) {
  if (kind === "video") return VIDEO_HINT;
  if (kind === "html") return HTML_HINT;
  return IMAGE_HINT;
}

function userMsg(kind, idea, draft) {
  const extra = String(draft || "").trim();
  const head = kind === "video" ? "扩成视频镜头提示词" : kind === "html" ? "扩成 HTML 设计稿六项 brief" : "扩成出图提示词";
  return extra
    ? `${head}。用户意图：${idea}\n\n已有草稿，请在保留主体事实的前提下改写成可拍成稿：\n${extra.slice(0, 2500)}`
    : `${head}。用户意图：${idea}`;
}

function clip(text, n) {
  const s = String(text || "").trim();
  return s.length <= n ? s : `${s.slice(0, n)}\n…`;
}

function distillSkill(text, n) {
  const stripped = String(text || "").replace(/^---[\s\S]*?---\s*/, "").trim();
  return clip(stripped, n);
}

function withBudget(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error("expand-timeout")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function defaultReadSkill(name) {
  const safe = String(name || "").replace(/[\\/]/g, "").replace(/\.\./g, "");
  if (!safe) return "";
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dirs = [
    path.join(here, "..", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const dir of dirs) {
    try {
      const f = path.join(dir, safe, "SKILL.md");
      if (fs.existsSync(f)) return fs.readFileSync(f, "utf8");
    } catch {}
  }
  return "";
}

export function loadExpandSkillHint(kind, { readSkill } = {}) {
  const k = kind === "video" ? "video" : kind === "html" || kind === "ppt" ? "html" : "image";
  const names = EXPAND_SKILLS[k] || [];
  const reader = typeof readSkill === "function" ? readSkill : defaultReadSkill;
  const parts = [];
  const used = [];
  for (const name of names) {
    const text = String(reader(name) || "").trim();
    if (!text) continue;
    used.push(name);
    parts.push(`【技能 ${name}】\n${distillSkill(text, SKILL_EACH)}`);
  }
  return { names: used, hint: clip(parts.join("\n\n"), SKILL_TOTAL) };
}

function systemHintFor(kind, skillHint) {
  const base = hintFor(kind);
  const extra = String(skillHint || "").trim();
  return extra ? `${base}\n\n按下面技能写，不要另起炉灶：\n${extra}` : base;
}

export async function expandWorkshopPrompt({ kind = "image", idea, draft, chat, skillHint, chatTimeoutMs } = {}) {
  const k = kind === "video" ? "video" : kind === "html" || kind === "ppt" ? "html" : "image";
  const seed = String(idea || "").trim();
  if (seed.length < 2) return { error: "先写一句想画或想拍的", prompt: "", fields: {}, source: "none" };
  if (typeof chat === "function") {
    const budget = Number(chatTimeoutMs) > 0 ? Number(chatTimeoutMs) : EXPAND_CHAT_MS;
    try {
      const r = await withBudget(chat(userMsg(k, seed, draft), {
        systemHint: systemHintFor(k, skillHint),
        maxTokens: EXPAND_MAX_TOKENS,
        thinking: false,
        timeout: budget,
      }), budget);
      const parsed = parseExpandJson(r?.text || r?.content || "");
      if (parsed?.prompt) {
        if (k !== "html") return { kind: k, source: "model", ...parsed };
        const fields = fillHtmlBrief({ theme: seed, verb: parsed.fields.verb, fields: parsed.fields });
        return { kind: k, source: "model", prompt: parsed.prompt, fields };
      }
    } catch {}
  }
  return { kind: k, ...fallbackExpand(k, seed) };
}

function modelKey(model) {
  if (!model?.provider || !model?.id) return "";
  return `${model.provider}/${model.id}`;
}

export async function handleExpandPrompt(ctx, res, body = {}) {
  const idea = String(body.idea || body.prompt || "").trim();
  const k = body.kind === "video" ? "video" : body.kind === "html" || body.kind === "ppt" ? "html" : "image";
  const model = pickExpandModel({
    defaultModel: typeof ctx.getDefaultModel === "function" ? ctx.getDefaultModel() : ctx.defaultModel,
    getModelList: ctx.getModelList || (() => []),
  }, body);
  const skills = loadExpandSkillHint(k, { readSkill: ctx.readSkill });
  const chat = ctx.directChat && model
    ? (msg, opts) => ctx.directChat(model, msg, [], {
      ...opts,
      tools: false,
      maxTokens: EXPAND_MAX_TOKENS,
      thinking: false,
      timeout: opts?.timeout || EXPAND_CHAT_MS,
    })
    : null;
  const r = await expandWorkshopPrompt({ kind: k, idea, draft: body.draft, chat, skillHint: skills.hint });
  if (r.error && !r.prompt) return json(res, 400, { error: r.error });
  return json(res, 200, {
    ok: true,
    prompt: r.prompt,
    fields: r.fields || {},
    source: r.source,
    model: modelKey(model),
    modelName: model?.name || model?.id || "",
    skills: skills.names,
  });
}
