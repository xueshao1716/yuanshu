// 元枢循环接缝：插件贡献能力，主聊天仍是 unifiedChat（不是 Gateway 循环）
import { buildYuanshuSections } from "./yuanshu-prompt.mjs";
import { tastePromptText } from './taste.mjs';
import { runtimeIdentity } from "./runtime-identity.mjs";
import { rhythmPhrase } from "./activity-rhythm.mjs";
import { resolvePersona, personaMeta } from "./persona-resolve.mjs";
import { systemPrompt, guardrailsText } from "./harness-components.mjs";
import { writeSelfFile } from "./self-model.mjs";
import { goldSection } from "./gold-facts.mjs";
import { workspaceFromEnv } from "./workspace-default.mjs";

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

// 时间事实算一次，system 版与 user 末尾版共用（2026-11-13）。
// 两版输出的**字面**会不同（一个进 system、一个贴到 user 末尾），但事实必须一致。
function timeCore(now, { since = 0, sessionStart = 0, rhythm = null } = {}) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const p = (n) => String(n).padStart(2, "0");
  const day = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
  const weekday = WEEKDAYS[t.getDay()];

  let sinceText = "";
  let sinceAgoMs = 0;
  const sinceMs = Number(since);
  if (Number.isFinite(sinceMs) && sinceMs > 0 && sinceMs <= t.getTime()) {
    sinceAgoMs = t.getTime() - sinceMs;
    sinceText = sincePhrase(sinceAgoMs);
  }
  let durationText = "";
  const startMs = Number(sessionStart);
  if (Number.isFinite(startMs) && startMs > 0 && startMs <= t.getTime() && startMs !== sinceMs) {
    durationText = durationPhrase(t.getTime() - startMs);
  }
  // 作息/节律：由 activity-rhythm 从真实时间戳观测得出，观测不到就什么都不说
  const rhythmText = rhythmPhrase(rhythm, t);
  return { t, day, weekday, sinceText, sinceAgoMs, durationText, rhythmText };
}

/** 旧位置：system 段里的时间上下文（YUANSHU_TIME_IN_USER=0 时仍走这条）。 */
export function promptTimeText(now = new Date(), opts = {}) {
  const c = timeCore(now, opts);
  const base = `当前时间：${c.day}（周${c.weekday}）。涉及时间/日期/定时/时效判断以此为准。`;

  const elapsed = [];
  if (c.sinceText) elapsed.push(c.sinceText);
  if (c.durationText) elapsed.push(`本次会话已持续 ${c.durationText}`);
  const lines = [];
  if (elapsed.length) lines.push(`（时间感）${elapsed.join("；")}。相隔较久时先承接上下文，不要假装刚刚还在聊。`);
  if (c.rhythmText) lines.push(`（作息）${c.rhythmText}。`);
  if (!lines.length) return base;
  return `${base}\n${lines.join("\n")}`;
}

/**
 * 新位置：贴在本轮 user 消息末尾的一行（2026-11-13）。
 *
 * 为什么搬：时间戳写在 system 里，同一会话隔一分钟就是两个不同的前导 system →
 * `prompt_cache_key` 每轮换一个，服务端前缀缓存也跟着失效，2 万 token 的固定开销每轮全价。
 * 模型要"现在几点/过了多久"这件事不变，所以信息一条不少，只是换了位置。
 * 注意：这里**故意不写**旧版那个中文冒号——用例断言时间格式串（带冒号那版）在
 * promptTimeText 里只有一处，注释里再抄一遍也会被数成两处。
 */
export function promptTimeNote(now = new Date(), opts = {}) {
  const c = timeCore(now, opts);
  const seg = [`当前时间 ${c.day}（周${c.weekday}）`];
  if (c.sinceText) seg.push(c.sinceText);
  if (c.durationText) seg.push(`本次会话已持续 ${c.durationText}`);
  const note = `【${seg.join(" · ")}】`;

  const extra = [];
  // "别假装刚刚还在聊"只在真的隔久了才说：隔三分钟讲这句是噪音，旧版每轮都讲
  if (c.sinceAgoMs >= 86400_000) extra.push("相隔较久，先承接上下文，不要假装刚刚还在聊。");
  if (c.rhythmText) extra.push(`（作息）${c.rhythmText}。`);
  return extra.length ? `${note}\n${extra.join("\n")}` : note;
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
  // 2026-10-24：品味库自动注入（最近 5 条判断）；调用方传了就不覆盖
  try {
    if (!baseOpts.taste) {
      const wsRoot = ctx.wsRoot || workspaceFromEnv() || process.cwd();
      baseOpts = { ...baseOpts, taste: tastePromptText(wsRoot, 5) };
    }
  } catch {}
  // 2026-10-24：黄金事实——路由按词面捞，闲聊/短句往往一条都捞不到；但这几条
  // （工作区、源码仓库、安装目录、主人联系方式）跟问题无关、每轮都得成立。
  // 放在 memory 段最前面：本轮捞到的记忆与它冲突时，以黄金事实为准。
  try {
    const goldRoot = ctx.wsRoot || workspaceFromEnv() || process.cwd();
    const gold = goldSection(goldRoot);
    if (gold) baseOpts = { ...baseOpts, goldFacts: gold };
  } catch {}
  // 2026-11-13（任务 B）：插件贡献的 skills/memory 也按"稳定/易变"分流。
  // 待兑现承诺（yuanshu:prompt:promises）自带「N 天前/已逾期」这类随时间变的措辞，
  // 若留在 system，承诺一多 system 就变；它和路由记忆一样属于"本轮参考"，随尾块走。
  const contribs = collectPromptContributions(registry, ctx);
  const merged = mergeContributedSections(
    buildYuanshuSections(baseOpts),
    contribs,
  );
  for (const c of contribs) {
    if (c.section === "memory") merged.memoryNote = [merged.memoryNote, c.text].filter(Boolean).join("\n\n");
    else if (c.section === "skills") merged.turnSkills = [merged.turnSkills, c.text].filter(Boolean).join("\n");
  }
  if (!String(merged.time || "").trim()) merged.time = promptTimeText(ctx.now, { since: ctx.since, sessionStart: ctx.sessionStart });
  // 2026-11-13：时间/间隔默认搬出 system（贴本轮 user 末尾），这里先把"末尾那条文案"算好。
  // 搬不搬由 yuanshu-prompt.prependAssembledSystem 按 YUANSHU_TIME_IN_USER 决定；
  // sections.time 仍然保留，是为了「预览/评测/回退」看到的和旧版一致（默认开关下 system 里不出现它）。
  merged.timeNote = promptTimeNote(ctx.now, { since: ctx.since, sessionStart: ctx.sessionStart, rhythm: ctx.rhythm });
  // 2026-10-25：人格段改由 engine/persona-resolve.mjs **一处**解析（定义 → 灵魂 → 自我 → 会话语气）。
  // 以前这三段在这里各拼一次、/api/persona 又自己渲染一遍，界面与注入迟早对不上。
  // 行为保持：贡献方已经给了 persona 就不再用定义覆盖，但灵魂/自我/会话语气照旧追加。
  {
    const pRoot = ctx.wsRoot || workspaceFromEnv() || process.cwd();
    let built = null;
    try {
      built = resolvePersona({
        wsRoot: pRoot,
        sessionId: ctx.sessionId || "",
        genes: ctx.genes || null,
        model: ctx.model,
        now: ctx.now instanceof Date ? ctx.now.getTime() : Date.now(),
      });
    } catch {}
    if (built) {
      const defPart = built.parts.find((p) => p.id === "definition");
      if (!String(merged.persona || "").trim()) {
        // 人格段由**定义**渲染（记忆/人格定义.json），而不是只报"本轮哪个模型在驱动"。
        // 真机 bug（2026-09-18）：元枢自制循环这条路上，小语的人格几乎没被注入过。
        const persona = (defPart && defPart.text) || promptPersonaText(ctx.model);
        if (persona) merged.persona = persona;
      }
      for (const part of built.parts) {
        if (part.id === "definition") continue;   // 定义已按上面的规则处理过
        merged.persona = [merged.persona, part.text].filter(Boolean).join("\n\n");
      }
      // 界面与注入同源：把这次真正拼进去的元数据留给 /api/persona 用
      merged.personaResolution = personaMeta(built);
      if (built.selfModel) { try { writeSelfFile(pRoot, built.selfModel); } catch {} }
    } else if (!String(merged.persona || "").trim()) {
      const fallback = promptPersonaText(ctx.model);
      if (fallback) merged.persona = fallback;
    }
  }
  // 2026-10-20：组件化第一步——协议文本与护栏都可外置为文件/单一真源；
  // 读不到文件时回退内置常量，行为与以前一致（只是多了可编辑与可追溯）。
  try {
    const hRoot = ctx.wsRoot || workspaceFromEnv() || process.cwd();
    const sys = systemPrompt(hRoot);
    if (sys?.text) merged.protocol = sys.text;
    const guard = guardrailsText(hRoot);
    if (guard) merged.guardrails = guard;
  } catch {}
  const identity = runtimeIdentity(ctx);
  if (identity) merged.runtime = [merged.runtime, identity].filter(Boolean).join('\n\n');
  return merged;
}
