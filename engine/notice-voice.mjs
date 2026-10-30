// ===== notice-voice.mjs —— 主动推送的"她自己说"（2026-10-30）=====
//
// 伙伴的原话：
//   「💬 元枢 · 下午━━━━━━━━• 离开 49 分钟 了，要不要回来接着做？—— 16:42 · 详情在元枢」
//   「这个汇报太生硬了，话术不活。前面改成主人物的名称，后面别写详情在元枢，应该简单汇报什么事。」
//   「晚上的反思进化、早上的晨报也应该报一下，排版让她自己决定，但一定要好看。」
//
// 所以这里做三件事：
//   1) 抬头用人设名（小语），不再用「元枢」；结尾写"什么事"，不写"详情在元枢"
//   2) 话由她自己写（模型生成 + 规则校验），不是查表拼字符串；写不好就重写一次，再不行才用兜底句
//   3) 覆盖：离开提醒 / 夜间反思进化 / 晨报
//
// 校验是硬的（长度、禁用词、"有没有说清什么事"），排版是软的（她决定，只要过校验）。
import fs from "node:fs";
import path from "node:path";

const PERSONA_REL = path.join("记忆", "人格定义.json");

export const FORBIDDEN = ["元枢", "详情在元枢", "系统提示", "作为AI", "作为一个AI"];

export function personaName(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(String(wsRoot || "."), PERSONA_REL), "utf8"));
    const name = String(raw?.name || raw?.名字 || "").trim();
    if (name) return name.slice(0, 12);
  } catch {}
  return "小语";
}

/** 兜底话术：模型不可用/不合格时才用。刻意口语、短、说清事。 */
export const FALLBACK = {
  away: ({ away }) => `你走了 ${away}，我这边的活还留着，回来接着做？`,
  night: ({ learned }) => `今天的活我过了一遍${learned ? `，记下 ${learned} 条` : ""}，明天能省点事。`,
  morning: ({ pending }) => `早，今天要做的事我列好了${pending ? `，${pending} 件在等你` : ""}。`,
  done: ({ what }) => `${what}，弄完了，你看一眼？`,
};

/** 各类型的写作要求（给模型的要求，不是最终文案） */
export function briefFor(kind, facts = {}) {
  // 2026-10-30：提示词里不要列"禁用词清单"——模型会把它原样复述回来。
  const base = [
    "写一条手机上发的短消息，第一人称，像跟熟人说话。",
    "40 字以内，最多一个 emoji，一眼能看出发生了什么。",
    "语气克制、可靠、像靠谱的搭档；可以轻松，但不抱怨、不自嘲、不玩梗。",
    "直接给消息本身，不要解释、不要列要求、不要加引号。",
  ];
  if (kind === "away") {
    return [...base,
      `背景：对方离开 ${facts.away || "一会儿"}。`,
      "只准说三件事：你还在、手头的活没丢、回来能接着做；不要提任何具体成果（不许说报告/任务/文件已交、已完成、已搞定）。不要催，不要卖惨。",
    ].join("\n");
  }
  if (kind === "night") {
    return [...base,
      `背景：今天共 ${facts.events ?? "一些"} 件事，反思后沉淀 ${facts.learned ?? 0} 条经验${facts.verdict ? `，结论：${facts.verdict}` : ""}。`,
      "要说清：你复盘了什么、学到什么、明天有什么用。别报流水账。",
    ].join("\n");
  }
  if (kind === "morning") {
    return [...base,
      `背景：今天有 ${facts.pending ?? 0} 件待办${facts.first ? `，第一件是「${facts.first}」` : ""}；昨天复盘 ${facts.learned ?? 0} 条。`,
      "要说清：今天大概要做什么、先做哪件。像晨会开场，不像天气预报。",
    ].join("\n");
  }
  return [...base, `背景：${facts.what || "一件事做完了"}。`].join("\n");
}

/** 校验：返回 {ok, reasons[]} */
export function checkNotice(text, { kind = "away", maxChars = 80 } = {}) {
  const t = String(text || "").trim();
  const reasons = [];
  if (!t) reasons.push("空内容");
  if (t.length > maxChars) reasons.push(`太长（${t.length} > ${maxChars}）`);
  for (const w of FORBIDDEN) if (t.includes(w)) reasons.push(`出现禁用词「${w}」`);
  if ((t.match(/\n/g) || []).length > 2) reasons.push("换行太多");
  // 2026-10-30：真机写过「复盘了 101 件破事…明天躺平摆烂 🤡」——这不是产品该有的语气
  if (/(摆烂|躺平|破事|宕机|烂透|崩了|废了|自闭)/.test(t)) reasons.push("语气太丧");
  // 2026-10-30：推理模型会把「我们需要回答…」这种思考过程当正文吐回来，这不是消息
  if (/^(我们需要|We need|让我|先看|首先|题目|好的，我)/.test(t)) reasons.push("这是推理过程，不是消息");
  // 2026-10-30：真机她写「报告已经交上去了」——离开提醒没有事实依据，不许编造成果
  if (kind === "away" && /(报告|交上去|提交|已完成|搞定|做完|发出去|睡)/.test(t)) reasons.push("编造了不存在的进度");
  // 至少有点具体信息：数字、时间、动作词，三选一
  if (!/\d/.test(t) && !/(分钟|小时|今天|昨天|明天|早|晚)/.test(t) && !/(做完|弄好|记下|列好|过了一遍|留着|复盘|整理|收尾|排好|归了|看了)/.test(t)) {
    reasons.push("没看出发生了什么");
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * 让她写一条：write(prompt) → 文本（模型）。校验不过重写一次，再不行兜底。
 * @returns {{text:string, source:'model'|'fallback'|'model-retry', reasons:string[]}}
 */
export async function composeNotice({ kind = "away", facts = {}, wsRoot = ".", write = null, maxChars = 80 } = {}) {
  const name = personaName(wsRoot);
  const fallback = (FALLBACK[kind] || FALLBACK.done)(facts);
  if (typeof write !== "function") return { text: fallback, source: "fallback", reasons: ["没有写作通道"] };

  const brief = briefFor(kind, facts);
  let lastReasons = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const prompt = attempt === 0
        ? `${brief}\n\n只输出这条消息本身，不要解释。`
        : `${brief}\n\n上一次这样写不行：${lastReasons.join("；")}。重写，仍然只输出消息本身。`;
      const raw = await write(prompt);
      let text = String(raw || "").trim().replace(/^["「『]|["」』]$/g, "").trim();
      // 写成长篇（复述要求）时，抽第一句真像消息的；抽不出来就让校验去判死
      if (text.length > maxChars && text.length > 120) {
        const sentences = text.split(/(?<=[。！？!?\n])/).map((x) => x.trim()).filter(Boolean);
        const pick = sentences.find((x) => x.length <= maxChars && !/^(要求|背景|注意|不要|规则|格式)[：:]/.test(x));
        if (pick) text = pick;
      }
      const checked = checkNotice(text, { kind, maxChars });
      if (checked.ok) return { text, source: attempt === 0 ? "model" : "model-retry", reasons: [] };
      lastReasons = checked.reasons;
    } catch (e) {
      lastReasons = [`写作失败：${String(e?.message || e).slice(0, 60)}`];
    }
  }
  try { if (lastReasons.length) console.log(`[notice] 用兜底话术（${kind}）：${lastReasons.join("；")}`) } catch {}
  return { text: fallback, source: "fallback", reasons: lastReasons };
}

/** 人类名 + 一句"什么事"，给推送排版用 */
export function noticeEnvelope({ kind = "away", facts = {}, now = Date.now(), text = "" }) {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const clockSlot = d.getHours() < 6 ? "夜里" : d.getHours() < 12 ? "早上" : d.getHours() < 14 ? "中午" : d.getHours() < 19 ? "下午" : "晚上";
  // 2026-10-30：时段要说的是"这条是什么简报"，不是此刻几点——夜里补跑的晨报不该写"下午"
  const slot = kind === "night" ? (d.getHours() < 5 ? clockSlot : "晚上") : kind === "morning" ? "早上" : clockSlot;
  const summary = kind === "night"
    ? `复盘 ${facts.events ?? 0} 件事${facts.learned ? `，沉淀 ${facts.learned} 条` : ""}`
    : kind === "morning"
      ? `今天 ${facts.pending ?? 0} 件待办${facts.first ? `，先做「${String(facts.first).slice(0, 14)}」` : ""}`
      : kind === "away"
        ? `你离开 ${facts.away || "一会儿"}，活还留着`
        : String(facts.what || "一件事做完了").slice(0, 24);
  return { head: `${slot} ${hh}:${mm}`, summary, body: text };
}
