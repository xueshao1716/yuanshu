// 元枢循环接缝：插件贡献能力，主聊天仍是 unifiedChat（不是 Gateway 循环）
import { buildYuanshuSections } from "./yuanshu-prompt.mjs";
import { runtimeIdentity } from "./runtime-identity.mjs";
import { rhythmPhrase } from "./activity-rhythm.mjs";
import { loadPersonaDefinition, renderPersonaSection } from "./persona-def.mjs";

export const SEAM_PROMPT = "prompt-section";

// 时间上下文的**唯一**格式化实现（此前有三份重复：这里、time-engine 的 nowContext、
// server.mjs 里一段内联；nowContext 零调用者是死代码，已删）。
//
// 只说"现在几点"是**时钟**，不是**时间感**。模型还需要知道"过了多久"：
// 隔了三天回来和刚聊完接着聊，语气与判断本来就该不一样。
// 注意 since 必须是**本轮更新之前**的上次对话时间——调用方要在 updateEmotion 之前取，
// 否则读到的已经是本轮时间、差值恒为 0（emotion.mjs 的 lastTalk 会被它自己刷新）。
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** 用于"距上次对话 X"这类从句：不带"前"，避免出现"距上次对话 3 天前"这种叠词。 */
export function sincePhrase(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const min = Math.floor(n / 60000);
  if (min < 1) return "上次对话就在刚刚";
  if (min < 60) return `距上次对话 ${min} 分钟`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `距上次对话 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `距上次对话 ${days} 天`;
  const months = Math.floor(days / 30);
  return months < 12 ? `距上次对话 ${months} 个月` : `距上次对话 ${Math.floor(months / 12)} 年`;
}

/** 用于"已持续 X"这类从句，去掉 0 分量（不写"3 天 0 小时"）。 */
export function durationPhrase(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  const min = Math.floor(n / 60000);
  if (min < 1) return "不到 1 分钟";
  if (min < 60) return `${min} 分钟`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return min % 60 ? `${hours} 小时 ${min % 60} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

export function promptTimeText(now = new Date(), { since = 0, sessionStart = 0, rhythm = null } = {}) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const d = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  const base = `当前时间：${d}（周${WEEKDAYS[t.getDay()]}）。涉及时间/日期/定时/时效判断以此为准。`;

  const elapsed = [];
  const sinceMs = Number(since);
  if (Number.isFinite(sinceMs) && sinceMs > 0 && sinceMs <= t.getTime()) {
    const phrase = sincePhrase(t.getTime() - sinceMs);
    if (phrase) elapsed.push(phrase);
  }
  const startMs = Number(sessionStart);
  if (Number.isFinite(startMs) && startMs > 0 && startMs <= t.getTime() && startMs !== sinceMs) {
    const phrase = durationPhrase(t.getTime() - startMs);
    if (phrase) elapsed.push(`本次会话已持续 ${phrase}`);
  }
  const lines = [];
  if (elapsed.length) lines.push(`（时间感）${elapsed.join("；")}。相隔较久时先承接上下文，不要假装刚刚还在聊。`);
  // 作息/节律：由 activity-rhythm 从真实时间戳观测得出，观测不到就什么都不说
  const rp = rhythmPhrase(rhythm, t);
  if (rp) lines.push(`（作息）${rp}。`);
  if (!lines.length) return base;
  return `${base}\n${lines.join("\n")}`;
}

export function promptPersonaText(model) {  if (!model?.id) return "";
  return `本轮由 ${model.provider} 通道的 ${model.id} 模型驱动，运行在元枢工作台（助手角色：小语）。用户问及你的模型/版本/能力时，以此如实回答；不要自称其他产品名。`;
}

export function mergeContributedSections(base = {}, contribs = []) {
  const next = { ...base };
  for (const c of contribs) {
    const id = String(c?.section || "").trim();
    const text = String(c?.text || "").trim();
    if (!id || !text) continue;
    if (c.replace || !String(next[id] || "").trim()) next[id] = text;
    else next[id] = `${String(next[id]).trim()}\n${text}`;
  }
  return next;
}

export function collectPromptContributions(registry, ctx = {}) {
  if (!registry || typeof registry.list !== "function") return [];
  const out = [];
  for (const p of registry.list()) {
    const svc = registry.get(p.id);
    if (!svc || svc.seam !== SEAM_PROMPT || typeof svc.contribute !== "function") continue;
    let text = "";
    try { text = String(svc.contribute(ctx) || "").trim(); } catch {}
    if (!text) continue;
    out.push({ seam: SEAM_PROMPT, section: svc.section, text, replace: !!svc.replace, id: p.id });
  }
  return out;
}

export async function registerPromptSection(registry, {
  id, name, section, contribute, replace = false, deps = [],
} = {}) {
  if (!registry?.load) throw new Error("需要 PluginRegistry");
  await registry.load({
    id,
    name: name || id,
    deps,
    mount: () => ({ seam: SEAM_PROMPT, section, contribute, replace }),
  });
  return id;
}

export function assembleYuanshuSystem(baseOpts = {}, registry = null, ctx = {}) {
  const merged = mergeContributedSections(
    buildYuanshuSections(baseOpts),
    collectPromptContributions(registry, ctx),
  );
  if (!String(merged.time || "").trim()) merged.time = promptTimeText(ctx.now, { since: ctx.since, sessionStart: ctx.sessionStart });
  if (!String(merged.persona || "").trim()) {
    // 人格段由**定义**渲染（记忆/人格定义.json），而不是只报"本轮哪个模型在驱动"。
    // 真机 bug（2026-09-18）：元枢自制循环这条路上，小语的人格几乎没被注入过——
    // 只有一句模型来源，所以她在这条路上的"是谁"是不确定的。
    let persona = "";
    try {
      const wsRoot = ctx.wsRoot || process.env.PI_WORKSPACE || process.cwd();
      const { def } = loadPersonaDefinition(wsRoot);
      persona = renderPersonaSection(def, { genes: ctx.genes || null, model: ctx.model });
    } catch {}
    if (!persona) persona = promptPersonaText(ctx.model);
    if (persona) merged.persona = persona;
  }
  const identity = runtimeIdentity(ctx);
  if (identity) merged.runtime = [merged.runtime, identity].filter(Boolean).join('\n\n');
  return merged;
}
