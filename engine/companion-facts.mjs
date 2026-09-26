import { createHash, randomUUID } from 'node:crypto';
const ACTIVE = new Set(['queued', 'running', 'stopping', 'recovering']);
const READ = new Set(['read', 'read_file', 'read_document_text', 'read_pdf']);
export const ACTIONS = ['neutral', 'working', 'reading', 'resting', 'daydreaming', 'listening', 'responding'];
export function resolveAction(facts, decision) {
  if (!facts?.known) return 'neutral';
  if (facts.currentBusy) return facts.reading ? 'reading' : 'working';
  if (facts.otherBusy > 0) return 'working';
  if (['reading', 'working'].includes(decision?.action)) return 'neutral';
  return ACTIONS.includes(decision?.action) ? decision.action : 'neutral';
}
export function createCompanionFacts({ manager, activeSessions = () => [], now = Date.now, serverEpoch = randomUUID() }) {
  return { read(sessionId) {
    let known = true, currentBusy = false, otherBusy = 0, reading = false, evidenceIds = [];
    try {
      const runs = manager.list().filter(run => ACTIVE.has(run.status));
      const busySessions = new Set(runs.map(run => run.sessionId));
      for (const id of activeSessions()) busySessions.add(id);
      currentBusy = !!sessionId && busySessions.has(sessionId);
      otherBusy = [...busySessions].filter(id => id !== sessionId).length;
      for (const run of runs.filter(run => sessionId && run.sessionId === sessionId)) {
        evidenceIds.push(`run:${run.id}`);
        const tools = new Map();
        for (const event of manager.readAfter(run.id, 0)) {
          const data = event.data || {}, id = data.id || data.toolCallId || data.effectKey;
          if (!id) continue;
          if (['tool', 'tool_start', 'tool_started'].includes(event.type)) tools.set(id, { name: data.name || data.toolName, seq: event.seq });
          if (['tool_end', 'tool_finished'].includes(event.type)) tools.delete(id);
        }
        for (const tool of tools.values()) if (READ.has(tool.name)) {
          reading = true; evidenceIds.push(`event:${run.id}:${tool.seq}`);
        }
      }
    } catch { known = false; currentBusy = false; otherBusy = 0; reading = false; evidenceIds = []; }
    const facts = { sessionId: sessionId || null, known, currentBusy, otherBusy, reading, evidenceIds };
    const revision = createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 24);
    return { ...facts, serverEpoch, revision, observedAt: now() };
  } };
}
