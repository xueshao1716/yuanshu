import { autoProposeFromDrift } from './gene.mjs';

// Completion hook creates candidates only. It never approves or edits baselines.
export function completeGeneTurn(sessionId) {
  if (!sessionId || /^eval-/.test(sessionId)) return [];
  const result = autoProposeFromDrift();
  if (result?.error && result.code !== 'not_initialized') console.warn('[gene-proposal]', result.error);
  return result;
}
