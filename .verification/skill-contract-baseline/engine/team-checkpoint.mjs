import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { reviewStoragePath, reviewAtomicWrite } from './review-file-safety.mjs';

export function createTeamCheckpoint({ wsRoot, id, task, maxCalls = 12 }) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('invalid checkpoint id');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 100) throw new Error('invalid call budget');
  const file = reviewStoragePath(wsRoot, `记忆/运行时/team-${id}.json`);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (state && (state.task !== task || state.version !== 1)) throw new Error('checkpoint mismatch');
  state ||= { version: 1, task, createdAt: new Date().toISOString(), calls: 0, maxCalls, steps: {} };
  if (!Number.isSafeInteger(state.calls) || state.calls < 0 || !Number.isSafeInteger(state.maxCalls) || state.maxCalls < 1 || state.maxCalls > 100 || !state.steps || typeof state.steps !== 'object' || Array.isArray(state.steps)) throw new Error('invalid checkpoint budget or steps');
  const save = () => reviewAtomicWrite(file, JSON.stringify(state));
  return {
    snapshot: () => structuredClone(state),
    async step(label, input, execute) {
      const digest = createHash('sha256').update(input).digest('hex');
      const previous = state.steps[label];
      if (previous?.digest !== undefined && previous.digest !== digest) throw new Error('checkpoint input mismatch');
      if (previous?.status === 'completed') return previous.result;
      if (previous?.status === 'running') throw new Error('uncertain stage: manual confirmation required');
      if (state.calls >= state.maxCalls) throw new Error('team call budget exhausted');
      state.calls++;
      state.steps[label] = { digest, status: 'running', startedAt: new Date().toISOString() };
      save(); // Reserve before dispatch; uncertainty must never grant a free retry.
      const result = await execute();
      state.steps[label] = { ...state.steps[label], status: 'completed', result, endedAt: new Date().toISOString() };
      save();
      return result;
    },
  };
}
