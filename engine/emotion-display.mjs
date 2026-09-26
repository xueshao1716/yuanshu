import { randomUUID } from 'node:crypto';
const LABELS = new Set(['loving', 'happy', 'curious', 'playful', 'calm', 'anxious', 'sad', 'angry', 'tired', 'neutral']);
const TAGS = new Set(['user_happy', 'user_frustrated', 'user_urgent', 'user_anxious', 'alert_risk', 'task_accomplish', 'task_deep']);
const finite = (v, min, max) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null;
export function safeEmotion(state) {
  if (!state || !['valence', 'arousal', 'dominance'].every(k => typeof state[k] === 'number' && Number.isFinite(state[k]))) return null;
  return {
    valence: finite(state.valence, -1, 1), arousal: finite(state.arousal, -1, 1),
    dominance: finite(state.dominance, -1, 1), intensity: finite(state.intensity, 0, 1),
    primary: LABELS.has(state.primary) ? state.primary : null,
    secondary: LABELS.has(state.secondary) ? state.secondary : null,
    tags: [...new Set((Array.isArray(state.tags) ? state.tags : []).filter(t => TAGS.has(t)))],
  };
}
export function observationTime(value) {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
export function createEmotionDisplay({ peek, now = Date.now, serverEpoch = randomUUID() }) {
  let revision = 0, fingerprint;
  return { read() {
    const observation = peek();
    const state = safeEmotion(observation?.state);
    const observedAt = observationTime(observation?.observedAt);
    const sourceKind = state ? observation?.sourceKind === 'dialogue' ? 'dialogue' : 'historical' : 'none';
    const next = JSON.stringify([observation?.source ?? null, state, observedAt, sourceKind]);
    if (next !== fingerprint) { revision++; fingerprint = next; }
    return { state, scope: 'global-latest', observedAt, servedAt: now(), sourceKind, revision, serverEpoch,
      status: !state ? 'unavailable' : sourceKind === 'dialogue' ? 'observed' : 'historical' };
  } };
}
