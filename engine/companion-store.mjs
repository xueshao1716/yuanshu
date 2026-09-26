import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from './atomic-io.mjs';
export function createCompanionStore({ root, now = Date.now }) {
  const file = path.join(root, '.yuanshu', 'companion.json');
  const load = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { dnd: false, history: [] }; }
  };
  const prune = data => (Array.isArray(data.history) ? data.history : []).filter(item => item.at >= now() - 7 * 86400000).slice(-1000);
  return {
    preferences(patch) {
      const data = load();
      if (patch) {
        if (typeof patch.dnd !== 'boolean') throw new Error('invalid_preferences');
        data.dnd = patch.dnd; data.history = prune(data); atomicWriteJson(file, data);
      }
      return { dnd: data.dnd === true };
    },
    record(item) {
      const data = load();
      // No prompts, session message copies or arbitrary model output persisted.
      const entry = { at: now(), sessionId: item.sessionId, interactionId: item.interactionId,
        status: item.status, action: item.action, decisionId: item.decisionId, evidenceIds: item.evidenceIds };
      data.history = [...prune(data), entry].slice(-1000); atomicWriteJson(file, data);
    },
    history(sessionId) { return prune(load()).filter(item => sessionId && item.sessionId === sessionId); },
  };
}
