export const ACTION_LABELS = { neutral: '静候', working: '工作中', reading: '阅读中', resting: '休息中', daydreaming: '放空中', listening: '倾听中', responding: '回应中' };
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
  // No model decision is not the same as no state. Keep the portrait alive from
  // observable UI activity, without inventing work or claiming that the model is
  // reading/sleeping. This only controls presentation; task facts above win.
  const now = Number.isFinite(ambient.now) ? ambient.now : Date.now();
  const lastActivityAt = Number.isFinite(ambient.lastActivityAt) ? ambient.lastActivityAt : now;
  const idle = Math.max(0, now - lastActivityAt);
  if (idle < 20_000) return 'listening';
  if (idle < 90_000) return 'resting';
  if (idle < 240_000) return 'daydreaming';
  // Long idle periods alternate instead of freezing on one pose forever.
  return Math.floor((idle - 240_000) / 45_000) % 3 === 2 ? 'listening' : (Math.floor((idle - 240_000) / 45_000) % 2 ? 'resting' : 'daydreaming');
}
export function shouldAutoDecide({ visible, dnd, sessionId, known, key, previous, pending, currentBusy }) {
  return !!(visible && !dnd && !pending && !currentBusy && sessionId && known && key && key !== previous);
}
export function isConversationEvent(event) {
  return !!(event && event.type !== 'subscribed' && !(typeof event.key === 'string' && Number.isInteger(event.lastSeq) && !event.type));
}
