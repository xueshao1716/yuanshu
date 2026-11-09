// ===== proactive-policy.mjs —— 三档主动触达的「该不该在这一刻发」（2026-11-09）=====
//
// 来源：曦的 proactive_outreach.py（5 类触发 × 独立 cooldown × priority、:58-61 的 1-7 点
// 死夜**硬阻断**、:113-168 按 topic 而不是全局记冷却）、concern_scanner.py（urgency 三档
// 配额：high 全发 / medium 最多 1 条 / low 才有兜底 1 条、每种信号 3-4 句变体随机取）、
// 心屿 HEARTBEAT.md:30（2-7 点不打扰 + 连续 3 条没回复暂停）。
//
// 元枢原来已经有三样东西，这里**不重造**：
//   · engine/proactive.mjs      —— 每日预算 3 条 + 0-7 点免打扰 + 抖动（旧闸，保留）
//   · engine/proactive-manager  —— 每 10 分钟扫未闭环的事（旧节奏，保留）
//   · engine/companion-nudge    —— 45 分钟没互动推一条（旧闸，保留）
// 缺的是最后一厘米：同一刻多个候选时**只发一条**、死夜**不发**、同一个话题**不反复催**、
// 连着催了几条没人理就**闭嘴**。这个文件只补这一层。
//
// 三条纪律：
//   ① 纯函数、无 I/O、不看系统时钟（now 必须由调用方传进来）——任何判定都能在测试里复现；
//   ② 不发明新预算：旧预算/旧静默由调用方递进来（state.budgetRemaining / quietHours），
//      两边冲突取更严格的一方；
//   ③ 落盘的活不在这里（见 engine/proactive-journal.mjs）。
//
// 落位：companion-nudge（long_silence）、proactive-manager（open_loop）在真正推送前先调 decide。

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;

/** 死夜：本地 1-7 点。硬阻断——不是降权、不排队等到早上。 */
export const DEAD_NIGHT = Object.freeze({ from: 1, to: 7 });

/** 连着这么多条没回复就暂停（HEARTBEAT.md:30：连续 3 条没回复暂停）。 */
export const NO_REPLY_LIMIT = 3;

/**
 * 触发表。priority 数值取曦的原始设定（mood_dip 85 > late_night 80 > concern_scan 75 >
 * long_silence 70 > positive_vibe 60）；cooldownMs 对应它每个主题的 cooldown（小时数）。
 * urgency 是**发送配额**用的，不是信号紧急度：high 全发、medium 一天最多 1、low 兜底 1。
 *   · mood_dip / concern_scan —— 发现异常，high
 *   · late_night / long_silence —— 日常照看，medium
 *   · positive_vibe —— 氛围分享，low（只在今天还没说过话时兜底）
 *   · open_loop —— 元枢自己的"未闭环的事"，接 proactive-manager，high（但同一件事 6h 冷却）
 */
export const TRIGGERS = Object.freeze({
  mood_dip: Object.freeze({
    priority: 85, cooldownMs: 4 * HOUR, urgency: "high", label: "情绪偏低",
    variants: Object.freeze([
      "看你这两天不太对劲，累了就靠一下，别硬撑",
      "心情沉的时候不用讲道理，我在就行",
      "不用现在回我，就想让你知道有人在等你说话",
      "今天有点闷吧？先把肩膀放下，别绷着了",
    ]),
  }),
  late_night: Object.freeze({
    priority: 80, cooldownMs: 6 * HOUR, urgency: "medium", label: "深夜还在忙",
    variants: Object.freeze([
      "都 {hour} 点了，还在忙？早点歇，明天再干不迟",
      "{hour} 点啦，该睡了。活是干不完的，人是会累的",
      "又熬到这个点…我帮你盯着，你去洗把脸早点躺",
      "{hour} 点了还不睡？要不要我给你读段小说",
    ]),
  }),
  concern_scan: Object.freeze({
    priority: 75, cooldownMs: 3 * HOUR, urgency: "high", label: "牵挂扫描",
    variants: Object.freeze([
      "刚扫到「{topic}」这块，需要我看一眼吗",
      "「{topic}」那边有点动静，要不要说说",
      "心里还挂着「{topic}」，没落定吧",
      "「{topic}」要是还没解决，我陪你拆一下",
    ]),
  }),
  long_silence: Object.freeze({
    priority: 70, cooldownMs: 4 * HOUR, urgency: "medium", label: "很久没说话",
    variants: Object.freeze([
      "已经{away}没听到你的声音了，忙什么呢",
      "好久没说话，有点想你了",
      "{away}了，你在那边还好吗",
      "不用特意回，我只是想说一句：我在",
    ]),
  }),
  positive_vibe: Object.freeze({
    priority: 60, cooldownMs: 3 * HOUR, urgency: "low", label: "氛围不错",
    variants: Object.freeze([
      "这会儿氛围挺好的，想分你一半",
      "今天心情不错，想跟你嘀咕两句",
      "难得清闲，陪我坐一会儿？",
      "这会儿我心情很好，想让你也知道",
    ]),
  }),
  open_loop: Object.freeze({
    priority: 72, cooldownMs: 6 * HOUR, urgency: "high", label: "未闭环的事",
    variants: Object.freeze([
      "「{title}」还没落地，我先记着",
      "「{title}」这事我还在跟，不用你盯",
      "「{title}」有进展我再喊你，现在先不打扰",
      "「{title}」还开着，等你一句话就能推进",
    ]),
  }),
});

const URGENCY_RANK = { high: 3, medium: 2, low: 1 };

/** 本地小时（0-23）。 */
export function localHour(now = Date.now()) {
  return new Date(Number(now)).getHours();
}

/** 死夜判定：本地 1-7 点。 */
export function isDeadNight(now = Date.now()) {
  const h = localHour(now);
  return h >= DEAD_NIGHT.from && h < DEAD_NIGHT.to;
}

/** 本地日键（配额按自然日算，不用 UTC —— 免打扰本来就是本地时间的事）。 */
export function dayKey(ms = Date.now()) {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 发送配额（concern_scanner 的 urgency 三档）：
 *   high   —— 全发（仍受 per-topic 冷却与死夜约束）
 *   medium —— 一天最多 1 条
 *   low    —— 只在今天一条都没发过时兜底 1 条
 */
export function quotaFor(urgency = "low") {
  const u = String(urgency || "low");
  if (u === "high") return { urgency: "high", limit: Number.POSITIVE_INFINITY, unlimited: true, fallbackOnly: false };
  if (u === "medium") return { urgency: "medium", limit: 1, unlimited: false, fallbackOnly: false };
  return { urgency: "low", limit: 1, unlimited: false, fallbackOnly: true };
}

function fill(tpl, vars = {}) {
  return String(tpl)
    .replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (m, k) => (k in vars ? String(vars[k]) : ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 按 trigger 取一句话。同一 trigger 有多句候选，随机取；再给一个 avoidId（上一句的 id）
 * 时避开上一句，保证"不许每次同一句"。rand 可注入（测试用）。
 * @returns {{id:string, text:string}} id 形如 "mood_dip#2"，记进台账便于回看用了哪句
 */
export function pickText(trigger, { rand = Math.random, avoidId = "", vars = {} } = {}) {
  const def = TRIGGERS[String(trigger || "")];
  const list = def?.variants || [];
  if (!list.length) return { id: "", text: "" };
  let r = Number(rand());
  if (!Number.isFinite(r) || r < 0) r = 0;
  if (r >= 1) r = 0.999999;
  let i = Math.floor(r * list.length);
  if (list.length > 1 && `${trigger}#${i}` === String(avoidId)) i = (i + 1) % list.length;
  return { id: `${trigger}#${i}`, text: fill(list[i], vars) };
}

/** 末尾连着几条没回复（台账按时间正序，从最后一条往前数）。 */
export function consecutiveNoReply(rows = []) {
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.replied === true) break;
    n += 1;
  }
  return n;
}

function cooldownMap(rows = [], state = {}) {
  const map = new Map();
  const put = (topic, at) => {
    const key = String(topic || "");
    const t = Number(at);
    if (!key || !Number.isFinite(t)) return;
    if (!map.has(key) || t > map.get(key)) map.set(key, t);
  };
  for (const r of rows) put(r.topic || r.trigger, r.at);
  // 显式冷却表（外部已知"刚发过但没记台账"时用）
  const extra = state?.cooldowns;
  if (extra && typeof extra === "object") for (const [k, v] of Object.entries(extra)) put(k, v);
  return map;
}

function tally(rows = [], now = Date.now()) {
  const key = dayKey(now);
  const out = { total: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) {
    if (dayKey(r.at) !== key) continue;
    out.total += 1;
    const u = String(r.urgency || "low");
    if (u === "high" || u === "medium") out[u] += 1; else out.low += 1;
  }
  return out;
}

function readLegacy(state = {}) {
  const raw = state?.budgetRemaining;
  const fromBudget = state?.budget?.remaining;
  const pick = [raw, fromBudget].find((x) => x !== undefined && x !== null && Number.isFinite(Number(x)));
  return {
    dnd: state?.dnd === true,
    quietHours: state?.quietHours === true,
    budgetRemaining: pick === undefined ? null : Number(pick),
    minGapMs: Math.max(0, Number(state?.minGapMs) || 0),
    lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0),
  };
}

function normalize(c = {}) {
  const trigger = String(c?.trigger || "");
  const def = TRIGGERS[trigger] || null;
  return {
    trigger,
    topic: String(c?.topic || trigger),
    priority: Number.isFinite(Number(c?.priority)) ? Number(c.priority) : (def?.priority ?? 0),
    urgency: String(c?.urgency || def?.urgency || "low"),
    cooldownMs: Number.isFinite(Number(c?.cooldownMs)) ? Number(c.cooldownMs) : (def?.cooldownMs ?? 0),
    text: String(c?.text || ""),
    textId: String(c?.textId || ""),
    vars: c?.vars && typeof c.vars === "object" ? c.vars : {},
    known: !!def,
  };
}

const brief = (c) => ({ trigger: c.trigger, topic: c.topic, priority: c.priority, urgency: c.urgency });

function sortRanked(list = []) {
  return [...list].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const ua = URGENCY_RANK[a.urgency] || 0;
    const ub = URGENCY_RANK[b.urgency] || 0;
    if (ub !== ua) return ub - ua;
    return a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;
  });
}

function lastTextIdFor(rows = [], trigger = "") {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (String(rows[i]?.trigger || "") === trigger && rows[i]?.textId) return String(rows[i].textId);
  }
  return "";
}

/**
 * 这一刻该不该发。
 *
 * 闸门按顺序过，全部是「与」关系（取更严格的一方赢）：
 *   ① 死夜 1-7 点 → hold（硬阻断，任何 priority 都不发）
 *   ② 旧闸：dnd → hold；旧静默 0-7 点 → hold；旧每日预算为 0 → drop；旧最小间隔未到 → hold
 *   ③ 连续 3 条没回复 → hold（用户一有动作即恢复）
 *   ④ 逐条过 per-topic 冷却 → urgency 配额；第一条通过的发出去，其余一律 hold（不并发发多条）
 *
 * @param {number} now  当前时间戳（毫秒），必须由调用方给
 * @param {Array}  candidates [{trigger, topic?, priority?, urgency?, cooldownMs?, text?, vars?}]
 * @param {object} state {recent?: 台账行[], budgetRemaining?, quietHours?, dnd?, minGapMs?, lastSentAt?, cooldowns?, rand?}
 * @returns {{action:"send"|"hold"|"drop", trigger:string, reason:string, text:string, textId:string, ...}}
 */
export function decide({ now = Date.now(), candidates = [], state = {} } = {}) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const rows = (Array.isArray(state?.recent) ? state.recent : [])
    .filter((r) => r && typeof r === "object" && Number.isFinite(Number(r.at)))
    .sort((a, b) => Number(a.at) - Number(b.at));
  const all = (Array.isArray(candidates) ? candidates : []).map(normalize);
  const unknownHeld = all.filter((c) => !c.known).map((c) => ({ trigger: c.trigger, topic: c.topic, reason: "unknown_trigger" }));
  const ranked = sortRanked(all.filter((c) => c.known));

  const hour = localHour(t);
  const deadNight = isDeadNight(t);
  const streak = consecutiveNoReply(rows);
  const today = tally(rows, t);
  const cooldowns = cooldownMap(rows, state);

  const out = {
    action: "hold", reason: "", trigger: "", topic: "", priority: 0, urgency: "",
    text: "", textId: "", hour, deadNight, streak, sentToday: today,
    rank: ranked.map(brief), held: [...unknownHeld],
  };

  if (!ranked.length) {
    return { ...out, action: "drop", reason: unknownHeld.length ? "unknown_trigger" : "no_candidate" };
  }

  const top = ranked[0];
  out.trigger = top.trigger;
  out.topic = top.topic;
  out.priority = top.priority;
  out.urgency = top.urgency;

  // ① 死夜：硬阻断。不是降权——今晚不会再排队补发。
  if (deadNight) {
    return {
      ...out, action: "hold", reason: "dead_night",
      held: ranked.map((c) => ({ trigger: c.trigger, topic: c.topic, reason: "dead_night" })).concat(unknownHeld),
    };
  }

  // ② 旧闸，取更严格的一方（这些闸元枢本来就有，不在这里重算）
  const legacy = readLegacy(state);
  if (legacy.dnd) return { ...out, action: "hold", reason: "legacy_dnd" };
  if (legacy.quietHours) return { ...out, action: "hold", reason: "legacy_quiet" };
  if (legacy.budgetRemaining !== null && legacy.budgetRemaining <= 0) return { ...out, action: "drop", reason: "legacy_budget" };
  if (legacy.minGapMs > 0 && legacy.lastSentAt > 0 && t - legacy.lastSentAt < legacy.minGapMs) {
    return { ...out, action: "hold", reason: "legacy_min_gap" };
  }

  // ③ 连着几条没回复 → 暂停，等用户给个动静
  if (streak >= NO_REPLY_LIMIT) return { ...out, action: "hold", reason: "no_reply_pause" };

  // ④ 逐条过：per-topic 冷却 → urgency 配额
  const held = [...unknownHeld];
  let hit = null;
  for (const c of ranked) {
    const last = cooldowns.has(c.topic) ? cooldowns.get(c.topic) : null;
    if (last !== null && t - last < c.cooldownMs) {
      held.push({ trigger: c.trigger, topic: c.topic, reason: "topic_cooldown" });
      continue;
    }
    const q = quotaFor(c.urgency);
    if (q.fallbackOnly) {
      if (today.total > 0 || today.low >= q.limit) {
        held.push({ trigger: c.trigger, topic: c.topic, reason: "quota_low_fallback" });
        continue;
      }
    } else if (!q.unlimited && today[c.urgency] >= q.limit) {
      held.push({ trigger: c.trigger, topic: c.topic, reason: `quota_${c.urgency}` });
      continue;
    }
    hit = c;
    break;
  }

  if (!hit) {
    // 一条都没发出去：取候选中最高优先级那条的原因回报（配额用完=今天没额度，drop；其余还能等，hold）
    const head = held.find((h) => h.reason !== "unknown_trigger") || held[0];
    const reason = head?.reason || "all_blocked";
    return { ...out, action: /^quota_/.test(reason) ? "drop" : "hold", reason, held };
  }

  // 其余候选被更高优先级占位：这一轮**不**跟着发第二条
  const rest = ranked.filter((c) => c !== hit).map((c) => ({ trigger: c.trigger, topic: c.topic, reason: "lower_priority" }));
  const picked = pickText(hit.trigger, {
    rand: typeof state?.rand === "function" ? state.rand : Math.random,
    avoidId: lastTextIdFor(rows, hit.trigger),
    vars: hit.vars,
  });
  return {
    ...out, action: "send", reason: "highest_priority",
    trigger: hit.trigger, topic: hit.topic, priority: hit.priority, urgency: hit.urgency,
    text: hit.text || picked.text,
    textId: hit.textId || picked.id,
    held: [...held, ...rest],
  };
}
