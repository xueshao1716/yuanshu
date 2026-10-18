export const ACTION_LABELS = { neutral: '静候', working: '工作中', reading: '阅读中', resting: '休息中', daydreaming: '放空中', listening: '倾听中', responding: '回应中', wave: '挥手', stretch: '伸懒腰', lookaround: '东张西望' };
export const APPEARANCE_DESCRIPTIONS = {
  neutral: '真人女性形象，面向前方，安静地陪伴与等待。', working: '真人女性形象，坐在桌前专注看屏幕，处于工作姿态。',
  reading: '真人女性形象，手持书本并低头阅读，处于阅读姿态。', resting: '真人女性形象，姿态放松，像是在短暂休息。',
  daydreaming: '真人女性形象，视线游离、神情放空，处于发呆姿态。', listening: '真人女性形象，面向用户，安静倾听。',
  responding: '真人女性形象，面向用户，正在回应。',
  wave: '真人女性形象，面向镜头抬手打招呼，自然地笑。', stretch: '真人女性形象，双臂上举伸懒腰，神情放松。',
  lookaround: '真人女性形象，身体侧转、视线看向一侧，像在张望。'
};
export function appearanceDescription(action) { return APPEARANCE_DESCRIPTIONS[action] || APPEARANCE_DESCRIPTIONS.neutral }
// accepted means the asset passed local decode/alpha checks and is enabled for rendering.
// These are state-specific真人姿态；动作仍由 companion facts + model decision 驱动。
export const PORTRAITS = {
  neutral: { src: '/assets/portraits/yuanshu-listening-v1.webp', accepted: true },
  working: { src: '/assets/portraits/yuanshu-working-v1.webp', accepted: true },
  reading: { src: '/assets/portraits/yuanshu-reading-v1.webp', accepted: true },
  resting: { src: '/assets/portraits/yuanshu-resting-v1.webp', accepted: true },
  daydreaming: { src: '/assets/portraits/yuanshu-daydreaming-v1.webp', accepted: true },
  listening: { src: '/assets/portraits/yuanshu-listening-v1.webp', accepted: true },
  responding: { src: '/assets/portraits/yuanshu-responding-v1.webp', accepted: true },
  // 2026-10-19：待机小动作（挥手/伸懒腰/东张西望），同角色同场景，用 agnes-image-2.5-flash 出的；
  // 用 ffmpeg 转 webp（795/796/869 KB → 26/29/29 KB），画质在脸部和发丝上无损可见。
  wave: { src: '/assets/portraits/yuanshu-wave-v1.webp', accepted: true },
  stretch: { src: '/assets/portraits/yuanshu-stretch-v1.webp', accepted: true },
  lookaround: { src: '/assets/portraits/yuanshu-lookaround-v1.webp', accepted: true },
};
export function portraitFor(action, manifest = PORTRAITS) {
  const asset = manifest[action];
  return asset?.accepted === true ? { src: asset.src, missing: false } : { src: PORTRAITS.neutral.src, missing: action !== 'neutral' };
}
export function acceptDecision(decision, context) {
  return !!(decision && context.visible && context.facts?.known && decision.sessionId === context.sessionId &&
    decision.contextEpoch === context.contextEpoch && decision.serverEpoch === context.facts.serverEpoch &&
    decision.basisRevision === context.facts.revision && Number.isFinite(decision.expiresAt) && decision.expiresAt > context.now);
}
export function actionFor(facts, decision, ambient = {}) {
  if (!facts?.known) return 'neutral';
  if (facts.currentBusy) return facts.reading ? 'reading' : 'working';
  if (facts.otherBusy > 0) return 'working';
  if (decision && !['working', 'reading'].includes(decision.action) && ACTION_LABELS[decision.action]) return decision.action;
  if (!ambient || !Number.isFinite(ambient.lastActivityAt)) return 'neutral';
  // No model decision is not the same as no state. Keep the portrait alive from
  // observable UI activity, without inventing work or claiming that the model is
  // reading/sleeping. This only controls presentation; task facts above win.
  const now = Number.isFinite(ambient.now) ? ambient.now : Date.now();
  const lastActivityAt = Number.isFinite(ambient.lastActivityAt) ? ambient.lastActivityAt : now;
  const idle = Math.max(0, now - lastActivityAt);
  if (idle < 20_000) return 'listening';
  if (idle < 90_000) return 'resting';
  if (idle < 240_000) return 'daydreaming';
  // 长空闲：在几种待机姿态之间轮换，不再死盯一个姿势（45 秒一换）
  const IDLE_ROTATION = ['listening', 'resting', 'daydreaming', 'lookaround', 'stretch', 'wave'];
  return IDLE_ROTATION[Math.floor((idle - 240_000) / 45_000) % IDLE_ROTATION.length];
}
export function shouldAutoDecide({ visible, dnd, sessionId, known, key, previous, pending, currentBusy }) {
  return !!(visible && !dnd && !pending && !currentBusy && sessionId && known && key && key !== previous);
}

/**
 * 主动互动的"时机标签"（2026-10-18：伙伴说主动互动弱）。
 * 原来只有 revision/情绪/30 秒空闲阶段三个变化点，冷启动、久别回来、刚干完活都不会开口。
 * 这里把几个自然的时机做成纯函数，交给 inputKey 去触发一次 auto 决策（服务端仍然限频和校验）。
 */
export function timeOfDay(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h) || h < 0 || h > 23) return 'unknown';
  if (h < 5) return 'lateNight';
  if (h < 9) return 'morning';
  if (h < 12) return 'forenoon';
  if (h < 14) return 'noon';
  if (h < 18) return 'afternoon';
  if (h < 23) return 'evening';
  return 'lateNight';
}

export function proactiveMoments({ now, mountedAt, lastActivityAt, wasBusy, isBusy, errorStreak } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const parts = [`tod:${timeOfDay(new Date(t).getHours())}`];
  // 刚打开：给她一次"见到你"的机会（只在最初 90 秒内算，不会反复）
  if (Number.isFinite(mountedAt) && t - mountedAt >= 0 && t - mountedAt < 90_000) parts.push('just-open');
  // 久别回来：离开超过 5 分钟后回来，重新评估一次
  if (Number.isFinite(lastActivityAt)) {
    const idle = t - lastActivityAt;
    if (idle >= 300_000) parts.push(`resume:${Math.floor(idle / 300_000)}`);
  }
  // 刚干完活：从忙到闲的那一刻值得说一句
  if (wasBusy === true && isBusy === false) parts.push('just-finished');
  // 连续出错：她该开口了（这类通常已经不在忙态，不会打断任务）
  const streak = Number.isFinite(errorStreak) ? Math.floor(errorStreak) : 0;
  if (streak >= 2) parts.push(`err:${Math.min(streak, 5)}`);
  return parts.join('|');
}
export function isConversationEvent(event) {
  return !!(event && event.type !== 'subscribed' && !(typeof event.key === 'string' && Number.isInteger(event.lastSeq) && !event.type));
}
