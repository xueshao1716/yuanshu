// engine/companion-nudge.mjs —— 长时间不互动时，把话推到应用外面
//
// 2026-10-18 伙伴：「长时间不互动也可以把消息推送出去的能力也得有」。
// 前台关掉之后没有客户端轮询，主动互动就断了；这里由服务端定时看一眼：
// 用户多久没来（seenAt）、上次推送多久了（nudgeAt）、免打扰是否开着，
// 条件都满足才通过 notifier 发一条（notifier 自带 in-app 事件，toWechat 时同时推微信）。
//
// 2026-11-09 三档主动触达：真正推送前先过 engine/proactive-policy.mjs 的 decide（死夜 1-7 点
// 硬阻断 / per-topic 冷却 / urgency 配额 / 连续 3 条没回复暂停）。上面那几道旧闸**一条没删**，
// 两边冲突时取更严格的一方（旧闸 in → 更严）。
import { decide, pickText } from "./proactive-policy.mjs";
import { readOutreach, recordOutreach } from "./proactive-journal.mjs";
import { isQuietHours } from "./proactive.mjs";

export const NUDGE_IDLE_MS = 45 * 60 * 1000;   // 至少 45 分钟没来才打扰
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 推过一次，3 小时内不再推
export const NUDGE_TRIGGER = "long_silence";
export const NUDGE_TOPIC = "companion:nudge";

/** 要不要推：三个条件缺一不可，且必须"确实离开过"（seenAt 有值）。 */
export function shouldNudge({ now = Date.now(), seenAt = 0, nudgeAt = 0, dnd = false,
  idleMs = NUDGE_IDLE_MS, cooldownMs = NUDGE_COOLDOWN_MS } = {}) {
  if (dnd) return { ok: false, reason: 'dnd' };
  if (!Number.isFinite(seenAt) || seenAt <= 0) return { ok: false, reason: 'never_seen' };
  if (!Number.isFinite(now) || now < seenAt) return { ok: false, reason: 'clock' };
  if (now - seenAt < idleMs) return { ok: false, reason: 'recently_seen' };
  if (Number.isFinite(nudgeAt) && nudgeAt > 0 && now - nudgeAt < cooldownMs) return { ok: false, reason: 'cooldown' };
  return { ok: true, reason: '' };
}

const hourOf = (ms) => new Date(ms).getHours();

/** 按时间段挑一句人话；深夜不吵，只报"我在"。 */
export function nudgeText({ now = Date.now(), idleMinutes = 0 } = {}) {
  // 2026-10-30：这一段原来查表拼「元枢 · 下午 / 离开 49 分钟」，伙伴说生硬。
  // 现在只给"事实"，话交给 notice-voice（她自己写 + 校验）。
  const away = idleMinutes >= 120 ? `${Math.floor(idleMinutes / 60)} 小时` : `${Math.max(1, Math.round(idleMinutes))} 分钟`;
  const h = hourOf(now);
  const slot = h < 6 ? '夜里' : h < 12 ? '早上' : h < 14 ? '中午' : h < 19 ? '下午' : '晚上';
  return { slot, away, title: slot, body: '', facts: { away } };
}

/**
 * 跑一次判断；到期就推。
 * @param {object}  o
 * @param {string}  o.wsRoot          工作区根；给了才读写主动推送台账（决定冷却与"连续没回复"）
 * @param {number}  o.budgetRemaining 旧每日预算剩几条（proactive.mjs 的 3 条池子）；null = 这道闸不设
 * @param {Function} o.rand           随机源，测试可注入
 * @returns {{ok:boolean, reason?:string, event?:object}}
 */
export async function runCompanionNudge({
  store, notifier, now = Date.now, force = false, compose = null, persona = "小语",
  wsRoot = "", budgetRemaining = null, rand = Math.random,
} = {}) {
  if (!store?.seen || !store?.preferences || !notifier?.notify) return { ok: false, reason: 'unavailable' };
  const t = now();
  const seen = store.seen();
  const prefs = store.preferences();
  const gate = shouldNudge({ now: t, seenAt: seen.seenAt, nudgeAt: seen.nudgeAt, dnd: prefs.dnd });
  if (!gate.ok && !(force && gate.reason === 'cooldown')) return gate;
  const idleMinutes = Math.max(0, Math.round((t - seen.seenAt) / 60000));
  const fact = nudgeText({ now: t, idleMinutes });
  // 2026-11-09：先把"这一刻该不该发"判掉。旧闸已经过了，这里只叠加更严格的那一层。
  // force 是「人明确要求推一条」，可以跳过冷却/配额/暂停，但**死夜不跳**（2-7 点不打扰是硬的）。
  const decision = decide({
    now: t,
    candidates: [{ trigger: NUDGE_TRIGGER, topic: NUDGE_TOPIC, vars: { away: fact.away, hours: Math.max(1, Math.round(idleMinutes / 60)) } }],
    state: {
      recent: wsRoot ? readOutreach(wsRoot) : [],
      dnd: prefs.dnd,
      quietHours: isQuietHours(t),
      budgetRemaining,
      lastSentAt: Number(seen.nudgeAt) || 0,
      rand,
    },
  });
  const bypass = force === true && decision.deadNight !== true;
  if (!bypass && decision.action !== "send") {
    return { ok: false, reason: decision.reason, policy: decision.action, trigger: NUDGE_TRIGGER };
  }
  // 2026-10-30：话由她自己写（校验长度/禁用词/有没有说清事）；
  // 2026-11-09：写不出来就用策略层的变体句兜底（原来这里是空字符串，force 时会推一条空的）。
  let body = decision.text || fact.body;
  let textId = decision.textId || "";
  if (!body) {
    const fb = pickText(NUDGE_TRIGGER, { rand, vars: { away: fact.away } });
    body = fb.text;
    if (!textId) textId = fb.id;
  }
  let source = textId ? "policy_template" : "template";
  if (typeof compose === "function") {
    try {
      const made = await compose({ kind: "away", facts: { away: fact.away } });
      if (made?.text) { body = made.text; source = made.source || "model"; textId = "model"; }
    } catch { /* 写作失败用兜底 */ }
  }
  const event = await notifier.notify({
    kind: 'companion', title: fact.title, body, sender: persona,
    summary: `你离开 ${fact.away}，活还留着`,
    key: `companion:nudge:${new Date(t).toISOString().slice(0, 10)}`, toWechat: true,
  });
  store.markNudge(t);
  // 记账：有了这一行，per-topic 冷却、连续 3 条没回复、以及"哪句话术被回过"才成立
  if (wsRoot) {
    recordOutreach(wsRoot, {
      at: t, trigger: NUDGE_TRIGGER, priority: decision.priority || 0, urgency: decision.urgency || "medium",
      topic: NUDGE_TOPIC, text: body, textId: textId || source, channel: "notify", kind: "companion",
    });
  }
  return { ok: true, event, trigger: NUDGE_TRIGGER, text: body, textId, source };
}
