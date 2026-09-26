export const ACTION_LABELS = { neutral: '静候', working: '工作中', reading: '阅读中', resting: '休息中', daydreaming: '放空中', listening: '倾听中', responding: '回应中' };
// accepted means enabled for rendering, not a claim of human visual approval.
// Base asset has decode/alpha checks; additional poses remain explicitly missing.
export const PORTRAITS = { neutral: { src: '/assets/portraits/yuanshu-cutout-v1.webp', accepted: true } };
export function portraitFor(action, manifest = PORTRAITS) {
  const asset = manifest[action];
  return asset?.accepted === true ? { src: asset.src, missing: false } : { src: PORTRAITS.neutral.src, missing: action !== 'neutral' };
}
export function acceptDecision(decision, context) {
  return !!(decision && context.visible && context.facts?.known && decision.sessionId === context.sessionId &&
    decision.contextEpoch === context.contextEpoch && decision.serverEpoch === context.facts.serverEpoch &&
    decision.basisRevision === context.facts.revision && Number.isFinite(decision.expiresAt) && decision.expiresAt > context.now);
}
export function actionFor(facts, decision) {
  if (!facts?.known) return 'neutral';
  if (facts.currentBusy) return facts.reading ? 'reading' : 'working';
  if (facts.otherBusy > 0) return 'working';
  return decision && !['working', 'reading'].includes(decision.action) && ACTION_LABELS[decision.action] ? decision.action : 'neutral';
}
export function shouldAutoDecide({ visible, dnd, sessionId, known, key, previous, pending, currentBusy }) {
  return !!(visible && !dnd && !pending && !currentBusy && sessionId && known && key && key !== previous);
}
export function isConversationEvent(event) {
  return !!(event && event.type !== 'subscribed' && !(typeof event.key === 'string' && Number.isInteger(event.lastSeq) && !event.type));
}
