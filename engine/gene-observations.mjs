// Auditable short-term expression. Observations are keyword signals, not personality measurements.
import { createHash, randomUUID } from 'node:crypto';

const DAY = 86400000;
export const EXPRESSION_HALF_LIFE_MS = 7 * DAY;
const MAX_EVENTS = 500;
const TAG_DELTAS = {
  user_frustrated: { gentleness: 0.05 },
  user_happy: { humor: 0.03, gentleness: 0.02 },
  task_deep: { curiosity: 0.03, learning: 0.04, initiative: 0.02 },
  task_accomplish: { creativity: 0.02, initiative: 0.02 },
  alert_risk: { caution: 0.03 },
};
const clamp = value => Math.max(0, Math.min(1, value));

export function updateExpression(genes, state, tags, { now = Date.now(), sessionId = '', message = '', turnId = '' } = {}) {
  if (!Number.isFinite(now) || /^eval-/.test(sessionId)) return false;
  const turnKey = turnId && sessionId ? createHash('sha256').update(JSON.stringify([String(sessionId), String(turnId)])).digest('hex') : null;
  if (turnKey && state.processedTurns?.includes(turnKey)) return false;
  const previous = Number.isFinite(state.lastObservedAt) ? state.lastObservedAt : now;
  if (now < previous) return false;
  const elapsed = Math.max(0, now - previous);
  const retention = Math.pow(0.5, elapsed / EXPRESSION_HALF_LIFE_MS);
  const recognized = [...new Set(Array.isArray(tags) ? tags : [])].filter(tag => TAG_DELTAS[tag]);
  let dirty = state.lastObservedAt == null || elapsed > 0;
  if (turnKey) { state.processedTurns = [...(state.processedTurns || []), turnKey].slice(-2000); dirty = true; }
  for (const [name, gene] of Object.entries(genes)) {
    const delta = recognized.reduce((sum, tag) => sum + (TAG_DELTAS[tag][name] || 0), 0);
    const next = clamp(gene.baseline + (gene.expression - gene.baseline) * retention + gene.mutability * delta);
    if (Number.isFinite(next) && next !== gene.expression) { gene.expression = next; dirty = true; }
  }
  state.lastObservedAt = Math.max(previous, now);
  if (recognized.length && sessionId && message && now >= previous) {
    const event = {
      id: randomUUID(), at: now, sessionId: String(sessionId).slice(0, 128), turnId: String(turnId).slice(0, 128), tags: recognized,
      messageHash: createHash('sha256').update(String(message)).digest('hex'),
      genes: Object.fromEntries(Object.entries(genes).map(([name, g]) => [name, { baseline: g.baseline, expression: g.expression }])),
    };
    state.events = [...(state.events || []), event].filter(e => e.at >= now - 30 * DAY).slice(-MAX_EVENTS);
    dirty = true;
  }
  return dirty;
}

export function driftEvidence(state, name, gene, now = Date.now()) {
  if (!Number.isFinite(now)) return [];
  const direction = Math.sign(gene.expression - gene.baseline);
  let samples = [];
  for (const event of state.events || []) {
    if (!event?.sessionId || !event.messageHash || !Number.isFinite(event.at) || event.at > now || now - event.at > 30 * DAY) continue;
    const sample = event.genes?.[name];
    const drift = (sample?.expression ?? NaN) - gene.baseline;
    if (sample?.baseline !== gene.baseline || Math.sign(drift) !== direction || Math.abs(drift) < 0.1) { samples = []; continue; }
    if (event.tags?.some(tag => TAG_DELTAS[tag]?.[name]) && !samples.some(e => e.at === event.at)) samples.push(event);
  }
  if (samples.length < 3 || samples.at(-1).at - samples[0].at < DAY || now - samples.at(-1).at > 7 * DAY) return [];
  // Keep both endpoints: a bounded evidence list must still show the observed time span.
  const picked = samples.length > 12 ? [samples[0], ...samples.slice(-11)] : samples;
  return picked.map(e => `gene-event:${e.id} ${new Date(e.at).toISOString()} session:${e.sessionId} tags:${e.tags.join(',')} sha256:${e.messageHash} baseline:${e.genes[name].baseline} expression:${e.genes[name].expression}`);
}
