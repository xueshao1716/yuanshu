import {clonePayload} from './state.mjs';
import {assertRequest} from './policy.mjs';

const fields = ['name', 'rationale', 'goals', 'curriculum', 'temporaryExpression',
  'observation', 'recovery', 'appearance', 'clothing', 'voice', 'permissions', 'protectedProposalRefs'];
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 4000 && !/[\x00-\x08]/.test(v);
const exact = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const list = (v, min = 0) => Array.isArray(v) && v.length >= min && v.length <= 32 &&
  v.every(text) && new Set(v).size === v.length;
const bad = () => { throw new Error('cultivation_invalid_design'); };

export function validateDesign(input) {
  const d = clonePayload(input);
  if (!exact(d, fields) || !text(d.name) || d.name.length > 120 ||
      !['rationale', 'temporaryExpression', 'observation', 'recovery'].every(k => text(d[k])) ||
      !list(d.goals, 1) || !list(d.curriculum, 1) || !list(d.protectedProposalRefs)) bad();
  for (const kind of ['appearance', 'clothing', 'voice']) {
    const media = d[kind];
    if (!exact(media, ['description', 'asset']) || !text(media.description)) bad();
    if (media.asset !== null && (!exact(media.asset, ['id', 'version']) ||
        !text(media.asset.id) || media.asset.id.length > 200 ||
        !Number.isSafeInteger(media.asset.version) || media.asset.version < 1)) bad();
  }
  const p = d.permissions;
  if (!exact(p, ['model', 'tools', 'dataScopes', 'remote', 'costUpperBoundCents']) ||
      !text(p.model) || p.model.length > 200 || !list(p.tools) || !list(p.dataScopes) ||
      typeof p.remote !== 'boolean' || !Number.isSafeInteger(p.costUpperBoundCents) ||
      p.costUpperBoundCents < 0) bad();
  return d;
}

export function assertAdoptable(input, policy, {now = Date.now(), agentId, verifyAsset} = {}) {
  const d = validateDesign(input);
  assertRequest(policy, d.permissions, now);
  if (d.protectedProposalRefs.length) throw new Error('cultivation_protected_proposal_pending');
  for (const kind of ['appearance', 'clothing', 'voice']) {
    if (!d[kind].asset) continue;
    const result = agentId && typeof verifyAsset === 'function' &&
      verifyAsset(Object.freeze({agentId, kind, ...d[kind].asset}));
    if (result instanceof Promise) result.catch(() => {});
    if (result !== true) throw new Error('cultivation_asset_unverified');
  }
  return true;
}

// Revisions may narrow, but cannot silently broaden an adopted envelope.
export function assertNoExpansion(next, previous) {
  const a = validateDesign(next).permissions, b = validateDesign(previous).permissions;
  if (a.model !== b.model || a.remote && !b.remote || a.costUpperBoundCents > b.costUpperBoundCents ||
      a.tools.some(x => !b.tools.includes(x)) || a.dataScopes.some(x => !b.dataScopes.includes(x)))
    throw new Error('cultivation_permission_expansion');
}
