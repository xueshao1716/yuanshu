// engine/companion-nudge.mjs —— 长时间不互动时，把话推到应用外面
//
// 2026-10-18 伙伴：「长时间不互动也可以把消息推送出去的能力也得有」。
// 前台关掉之后没有客户端轮询，主动互动就断了；这里由服务端定时看一眼：
// 用户多久没来（seenAt）、上次推送多久了（nudgeAt）、免打扰是否开着，
// 条件都满足才通过 notifier 发一条（notifier 自带 in-app 事件，toWechat 时同时推微信）。

export const NUDGE_IDLE_MS = 45 * 60 * 1000;   // 至少 45 分钟没来才打扰
export const NUDGE_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 推过一次，3 小时内不再推

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
  const h = hourOf(now);
  const away = idleMinutes >= 120 ? `${Math.floor(idleMinutes / 60)} 小时` : `${Math.max(1, Math.round(idleMinutes))} 分钟`;
  if (h < 6) return { title: '元枢 · 夜深了', body: `你走了 ${away}，我这边没什么事。早点睡。` };
  if (h < 12) return { title: '元枢 · 早', body: `离开 ${away} 了，回来看看？我一直在。` };
  if (h < 14) return { title: '元枢 · 中午', body: `离开 ${away} 了，记得吃饭。有事我在这儿。` };
  if (h < 19) return { title: '元枢 · 下午', body: `离开 ${away} 了，要不要回来接着做？` };
  return { title: '元枢 · 晚上好', body: `离开 ${away} 了，今天的事还留着，回来我陪你收个尾。` };
}

/**
 * 跑一次判断；到期就推。
 * @returns {{ok:boolean, reason?:string, event?:object}}
 */
export async function runCompanionNudge({ store, notifier, now = Date.now, force = false } = {}) {
  if (!store?.seen || !store?.preferences || !notifier?.notify) return { ok: false, reason: 'unavailable' };
  const t = now();
  const seen = store.seen();
  const prefs = store.preferences();
  const gate = shouldNudge({ now: t, seenAt: seen.seenAt, nudgeAt: seen.nudgeAt, dnd: prefs.dnd });
  if (!gate.ok && !(force && gate.reason === 'cooldown')) return gate;
  const idleMinutes = Math.max(0, Math.round((t - seen.seenAt) / 60000));
  const text = nudgeText({ now: t, idleMinutes });
  const event = await notifier.notify({
    kind: 'companion', title: text.title, body: text.body,
    key: `companion:nudge:${new Date(t).toISOString().slice(0, 10)}`, toWechat: true,
  });
  store.markNudge(t);
  return { ok: true, event };
}
