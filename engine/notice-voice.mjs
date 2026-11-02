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
  away: ({ away, done, blocked, asks }) => {
    const d = Array.isArray(done) ? done.filter(Boolean) : [];
    const b = Array.isArray(blocked) ? blocked.filter(Boolean) : [];
    const a = Number(asks) || 0;
    const parts = [`你走这 ${away}`];
    if (d.length) parts.push(`完了 ${d.length} 件（${d.slice(0, 2).join("、")}${d.length > 2 ? "…" : ""}）`);
    if (b.length) parts.push(`${b.length} 件卡着（${b.slice(0, 2).join("、")}）`);
    if (a > 0) parts.push(`${a} 件事等你拍板`);
    if (!d.length && !b.length && !a) return `你走这 ${away}，没什么要你管的。`;
    return `${parts.join("；")}。`;
  },
  reflection: ({ events, winner }) => (Number(events) > 0
    ? `夜里回放 ${events} 条轨迹${winner ? `，${winner} 更稳` : ""}，明天按这个来。`
    : "今天轨迹不够，没做结论，明天接着看。"),
  night: ({ learned }) => `今天的活我过了一遍${learned ? `，记下 ${learned} 条` : ""}，明天能省点事。`,
  morning: ({ pending }) => `早，今天要做的事我列好了${pending ? `，${pending} 件在等你` : ""}。`,
  ask: ({ what }) => `有个事得你拍板：${String(what || "外面进来的一件事").slice(0, 50)}`,
  done: ({ what, minutes, gate }) => (gate?.verdict === "RED"
    ? `${what || "手头的活"}干完了，但交付门没过：${String(gate.summary || "有改动没被验证").slice(0, 60)}`
    : gate?.verdict === "YELLOW"
      ? `${what || "手头的活"}做完了，${String(gate.summary || "需要你确认").replace(/^可以交付[，,]?/, "").slice(0, 70)}`
      : `${what || "手头的活"}做完了${minutes ? `，用了 ${minutes} 分钟` : ""}，看一眼？`),
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
      "说清这段时间实际发生了什么：完成了几件、卡在哪、有没有事等他决定。只许用给定的数字与名称，不许编。不要问「回来接着做？」，不要催，不要卖惨。",
    ].join("\n");
  }
  if (kind === "night") {
    return [...base,
      `背景：今天共 ${facts.events ?? "一些"} 件事，反思后沉淀 ${facts.learned ?? 0} 条经验${facts.verdict ? `，结论：${facts.verdict}` : ""}。`,
      "要说清：你复盘了什么、学到什么、明天有什么用。别报流水账。",
    ].join("\n");
  }
  if (kind === "ask") {
    return [...base,
      `背景：外面进来一件事，需要伙伴拍板才能做：${String(facts.what || "").slice(0, 200)}`,
      `来源：${facts.source || "未知"}`,
      "要说清：什么事、为什么必须他点头、他点头之后你会怎么做。不要催，不要说套话。",
    ].join("\n");
  }
  if (kind === "done" && facts.gate?.verdict === "RED") {
    return [...base,
      `背景：${facts.what || "手头的活"} 的改动没有被验证覆盖：${String(facts.gate.summary || "").slice(0, 80)}`,
      "必须如实说：活干到哪、交付门为什么没过、还差什么验证。不许说完成。",
    ].join("\n");
  }
  if (kind === "done") {
    return [...base,
      `背景：${facts.what || "手头的活"} 已经做完了${facts.minutes ? `，用了 ${facts.minutes} 分钟` : ""}。`,
      "要说清：哪件事做完了、用了多久、结果在哪看。别邀功，别重复对方的话。",
    ].join("\n");
  }
  if (kind === "reflection") {
    return [...base,
      facts.report
        ? `背景：她 0 点自己写了一份复盘报告，从里面沉淀了 ${facts.learned ?? 0} 条经验。`
        : `背景：夜里回放 ${facts.events ?? 0} 条轨迹${facts.winner ? `，选出新策略「${facts.winner}」` : ""}，沉淀 ${facts.learned ?? 0} 条。`,
      "要说清：你回看了什么、得出了什么结论、明天因此会有什么不同。不要写流水账。",
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
export function checkNotice(text, { kind = "away", maxChars = 80, facts = {} } = {}) {
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
  // 2026-10-30：真机反思写成「发现有一处关键遗漏，已沉淀修正方案」，但那次回放 0 条。
  // 没有数据就只能说"今天没攒够"，不许虚构发现。
  const noTrace = !Number(facts.events);
  if (kind === "reflection" && noTrace) {
    // 允许「没做结论 / 没有发现」这种诚实表述；只拦"声称有发现"的说法
    const claims = /(?<!没|没有|无|未|不够|缺少)(发现|遗漏|梳理出|沉淀出|修正|关键)/;
    if (claims.test(t)) reasons.push("没有轨迹却说有发现");
    if (/沉淀\s*[0-9一二三四五六七八九十]+\s*条/.test(t)) reasons.push("没有轨迹却说沉淀了几条");
  }
  // 回放 0 条时连"沉淀 N 条"也不许说——那是编出来的成绩
  if (kind === "reflection" && !Number(facts.events) && /沉淀\s*[0-9一二三四五六七八九十]+\s*条/.test(t)) reasons.push("没有轨迹却说沉淀了几条");
  // 2026-10-30：真机她写「报告已经交上去了」——离开提醒没有事实依据，不许编造成果
  if (kind === "away" && /(报告|交上去|提交|已完成|搞定|做完|发出去|睡)/.test(t)) reasons.push("编造了不存在的进度");
  // 至少有点具体信息：数字、时间、动作词，三选一
  if (!/\d/.test(t) && !/(分钟|小时|今天|昨天|明天|早|晚)/.test(t) && !/(做完|弄好|弄完|记下|列好|过了一遍|留着|复盘|整理|收尾|排好|归了|看了|完成|跑完|交付|好了)/.test(t)) {
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
  // 2026-10-31：交付门 RED 时，直接给"没过门"的兜底——不把决定权交给模型
  if (kind === "done" && facts.gate && ["RED", "YELLOW"].includes(facts.gate.verdict)) {
    const text = FALLBACK.done(facts);
    try { if (typeof write === "function" && !writeBlocked) console.log("[notice] 交付门 RED，使用兜底话术") } catch {}
    return { text, source: "fallback", reasons: [`交付门 ${facts.gate.verdict}`] };
  }
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
      const checked = checkNotice(text, { kind, maxChars, facts });
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
  const summary = kind === "ask" ? `要你拍板：${String(facts.what || "").slice(0, 30)}` : kind === "reflection" ? `回放 ${facts.events ?? 0} 条${facts.winner ? ` · 新策略 ${facts.winner}` : ""}` : kind === "night"
    ? `复盘 ${facts.events ?? 0} 件事${facts.learned ? `，沉淀 ${facts.learned} 条` : ""}`
    : kind === "morning"
      ? `今天 ${facts.pending ?? 0} 件待办${facts.first ? `，先做「${String(facts.first).slice(0, 14)}」` : ""}`
      : kind === "away"
        ? `你离开 ${facts.away || "一会儿"}，活还留着`
        : String(facts.what || "一件事做完了").slice(0, 24);
  return { head: `${slot} ${hh}:${mm}`, summary, body: text };
}
