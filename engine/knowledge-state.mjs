import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const clone = value => structuredClone(value);
export const fail = code => { throw Object.assign(new Error(code), {code}); };
export const active = new Set(['collecting','extracting','validating','ready']);
export const terminal = new Set(['committed','cancelled','skipped','failed']);
export const states = new Set(['queued',...active,...terminal,'retry_wait','blocked','review_required','paused']);
const next = {collecting:'extracting',extracting:'validating',validating:'ready'};
export const validId = id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
export function checkId(id) { if (!validId(id)) fail('invalid_id'); return id; }
export function assertClaim(job, guard, policy, now) {
  if (policy.paused || !policy.localEnabled || job.policyRevision !== policy.revision || guard.policyRevision !== policy.revision) fail('policy_changed');
  if (!active.has(job.state) || job.revision !== guard.revision || job.generation !== guard.generation ||
      job.lease?.owner !== guard.owner || job.lease?.expiresAt <= now) fail('stale_claim');
}
export const guardFor = job => ({revision:job.revision,generation:job.generation,owner:job.lease?.owner,policyRevision:job.policyRevision});
export function advanceJob(job, patch, now) {
  const allowed = new Set(['state','reason','nextAttemptAt','attempts','snapshots','candidate','validation','cost','artifacts']);
  if (Object.keys(patch).some(k=>!allowed.has(k))) fail('invalid_transition');
  if (patch.state && patch.state !== job.state && patch.state !== next[job.state] &&
      !['blocked','review_required','retry_wait','skipped','failed'].includes(patch.state)) fail('invalid_transition');
  const updated = {...job,...clone(patch),revision:job.revision+1,updatedAt:now};
  if (active.has(updated.state)) updated.stage=updated.state;
  else updated.lease=null;
  return updated;
}
