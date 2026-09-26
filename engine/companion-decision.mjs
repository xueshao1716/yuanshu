import { randomUUID } from 'node:crypto';
import { coalesceCompanionRequests } from './companion-inflight.mjs';
import { resolveAction } from './companion-facts.mjs';
import { safeEmotion } from './emotion-display.mjs';
import { COMPANION_PROMPT, validateCompanionOutput } from './companion-policy.mjs';
export function compactMessages(messages) {
  let remaining = 6000;
  return (messages || []).filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-6).reverse().map(m => { const content = m.content.slice(-remaining); const out = { role: m.role, content: remaining ? content : '' }; remaining -= out.content.length; return out; }).reverse().filter(m => m.content);
}
export function createCompanionDecision({ store, facts, emotion, readSession, callModel, now = Date.now, timeoutMs = 12000 }) {
  const sessions = new Map(), inflight = new Map(), cache = new Map();
  let total = 0;
  return { decide: coalesceCompanionRequests(async (input, signal) => {
    const { sessionId, contextEpoch, interactionId } = input || {};
    if (![sessionId, contextEpoch, interactionId].every(x => typeof x === 'string' && x.length > 0 && x.length <= 160)) return { status: 'invalid_request' };
    if (!['auto', 'tap', 'text', 'busy', 'rest'].includes(input.trigger) || typeof input.text !== 'undefined' && (typeof input.text !== 'string' || input.text.length > 500)) return { status: 'invalid_request' };
    const auto = input.trigger === 'auto', key = JSON.stringify([sessionId, contextEpoch, interactionId]);
    for (const [id, value] of cache) if (value.at < now() - 3600000) cache.delete(id);
    if (cache.has(key)) return cache.get(key).value;
    if (auto && input.visible !== true) return { status: 'hidden' };
    if (auto && store.preferences().dnd) return { status: 'dnd' };
    if (inflight.has(sessionId) || total >= 2) return { status: 'busy' };
    for (const [id, quota] of sessions) if (now() - quota.touched > 3600000 && !inflight.has(id)) sessions.delete(id);
    if (!sessions.has(sessionId) && sessions.size >= 1000) return { status: 'rate_limited' };
    const quota = sessions.get(sessionId) || { auto: [], manual: [], failureAt: -Infinity, touched: now() };
    const bucket = auto ? 'auto' : 'manual';
    quota[bucket] = quota[bucket].filter(t => t > now() - 3600000);
    if (auto && now() - quota.failureAt < 60000 || quota[bucket].length >= (auto ? 20 : 60) || now() - (quota[bucket].at(-1) ?? -Infinity) < (auto ? 30000 : 2000)) return { status: 'rate_limited' };
    if (signal?.aborted) return { status: 'cancelled' };
    quota[bucket].push(now()); quota.touched = now(); sessions.set(sessionId, quota);
    total++; inflight.set(sessionId, key);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer, onAbort, status = 'unavailable', decision;
    try {
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new Error('cancelled'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { reject(new Error('timeout')); controller.abort(); }, timeoutMs);
        if (controller.signal.aborted) onAbort();
      });
      const before = facts.read(sessionId);
      if (!before.known) { status = 'facts_unavailable'; throw new Error(status); }
      const session = await Promise.race([cancelled, Promise.resolve().then(() => readSession(sessionId))]);
      if (!session?.model) { status = 'session_unavailable'; throw new Error(status); }
      const prompt = JSON.stringify({ facts: before, emotion: safeEmotion(emotion.read()?.state),
        messages: compactMessages(session.messages), interaction: { trigger: input.trigger, text: input.text || '' }, preferences: store.preferences() });
      const response = await Promise.race([cancelled, callModel(session.model, prompt, [], {
        systemHint: COMPANION_PROMPT, maxTokens: 700, timeout: timeoutMs, signal: controller.signal,
        thinking: false, allowPartial: true, throwOnError: true, trackModelHealth: false,
      })]);
      const after = facts.read(sessionId);
      const currentSession = await Promise.race([cancelled, Promise.resolve().then(() => readSession(sessionId))]);
      if (signal?.aborted) status = 'cancelled';
      else if (!currentSession || session.revision !== currentSession.revision || before.revision !== after.revision || before.serverEpoch !== after.serverEpoch) status = 'stale';
      else {
        const parsed = response?.truncated ? null : validateCompanionOutput(response?.text, after);
        if (!parsed || !response?.usedModel?.id || !response?.usedModel?.provider) status = 'invalid';
        else {
          const action = resolveAction(after, parsed), constrained = action !== parsed.action;
          decision = { ...parsed, action, utterance: constrained ? '' : parsed.utterance,
            reason: constrained ? '运行事实优先于呈现决定' : parsed.reason,
            shouldInterrupt: !store.preferences().dnd && parsed.shouldInterrupt,
            decisionId: randomUUID(), sessionId, contextEpoch, basisRevision: after.revision,
            serverEpoch: after.serverEpoch, expiresAt: now() + parsed.durationMs,
            actualModel: { provider: String(response.usedModel.provider).slice(0, 120), id: String(response.usedModel.id).slice(0, 120) },
            decisionSource: 'model', executionEngine: 'companion-readonly' };
          status = 'ok';
        }
      }
    } catch { status = signal?.aborted ? 'cancelled' : status; }
    finally {
      clearTimeout(timer); if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', abort); inflight.delete(sessionId); total--;
    }
    if (['unavailable', 'invalid', 'facts_unavailable', 'session_unavailable'].includes(status)) quota.failureAt = now();
    const value = decision ? { status, decision } : { status };
    cache.set(key, { at: now(), value }); if (cache.size > 1000) cache.delete(cache.keys().next().value);
    store.record({ sessionId, interactionId, status, action: decision?.action, decisionId: decision?.decisionId, evidenceIds: decision?.evidenceIds });
    return value;
  }) };
}
