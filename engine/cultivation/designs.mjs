import {clonePayload} from './state.mjs';
import {assertEnvelope} from './policy.mjs';
import {CULTIVATION_DESIGN_SCHEMA, curriculumItemHint} from './design-schema.mjs';

const fields = CULTIVATION_DESIGN_SCHEMA.required;
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 4000 && !/[\x00-\x08]/.test(v);
const exact = (v, keys) => v && !Array.isArray(v) && typeof v === 'object' &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const validationErrors = new WeakSet();
const bad = (field, expected) => {
  const error = Object.assign(new Error('cultivation_invalid_design'), {field, expected});
  validationErrors.add(error);
  throw error;
};
// Never forward arbitrary exception properties, paths, input values or stacks.
export const designValidationDetails = error => validationErrors.has(error)
  ? {error:'cultivation_invalid_design', field:error.field, expected:error.expected} : null;
function checkObject(value, keys, field) {
  if (exact(value, keys)) return;
  const missing = value && typeof value === 'object' && !Array.isArray(value) && keys.find(k => !Object.hasOwn(value, k));
  bad(missing ? `${field}.${missing}` : field, `必需对象字段：${keys.join(', ')}；不可遗漏或添加字段`);
}
function checkText(value, field, max = 4000, hint = '非空字符串') {
  if (!text(value) || value.length > max) bad(field, `${hint}（最多${max}字符，不含非法控制字符）`);
}
function checkList(value, field, min = 0, hint) {
  if (!Array.isArray(value) || value.length < min || value.length > 32)
    bad(field, `由${min}至32个不重复非空字符串组成的数组`);
  value.forEach((item, index) => checkText(item, `${field}[${index}]`, 4000, hint));
  if (new Set(value).size !== value.length) bad(field, '字符串数组中不可包含重复项');
}

export function validateDesign(input) {
  const d = clonePayload(input);
  checkObject(d, fields, 'design');
  checkText(d.name, 'design.name', 120);
  for (const key of ['rationale', 'temporaryExpression', 'observation', 'recovery']) checkText(d[key], `design.${key}`);
  checkList(d.goals, 'design.goals', 1);
  checkList(d.curriculum, 'design.curriculum', 1, curriculumItemHint);
  checkList(d.protectedProposalRefs, 'design.protectedProposalRefs');
  for (const kind of ['appearance', 'clothing', 'voice']) {
    const media = d[kind], field = `design.${kind}`;
    checkObject(media, ['description', 'asset'], field);
    checkText(media.description, `${field}.description`);
    if (media.asset !== null) {
      checkObject(media.asset, ['id', 'version'], `${field}.asset`);
      checkText(media.asset.id, `${field}.asset.id`, 200);
      if (!Number.isSafeInteger(media.asset.version) || media.asset.version < 1)
        bad(`${field}.asset.version`, '大于等于1的安全整数；未绑定资产请将asset设为null');
    }
  }
  const p = d.permissions;
  checkObject(p, ['model', 'tools', 'dataScopes', 'remote', 'costUpperBoundCents'], 'design.permissions');
  checkText(p.model, 'design.permissions.model', 200);
  for (const key of ['tools', 'dataScopes']) checkList(p[key], `design.permissions.${key}`);
  if (typeof p.remote !== 'boolean') bad('design.permissions.remote', '布尔值true或false');
  if (!Number.isSafeInteger(p.costUpperBoundCents) || p.costUpperBoundCents < 0)
    bad('design.permissions.costUpperBoundCents', '大于等于0的安全整数，单位为分');
  return d;
}

export function assertAdoptable(input, policy, {now = Date.now(), agentId, verifyAsset, execution = true} = {}) {
  const d = validateDesign(input);
  assertEnvelope(policy, d.permissions, now, {execution});
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
export function assertNoExpansion(next, previous, {allowRemoteExpansion = false} = {}) {
  const a = validateDesign(next).permissions, b = validateDesign(previous).permissions;
  if (a.model !== b.model || a.remote && !b.remote && !allowRemoteExpansion || a.costUpperBoundCents > b.costUpperBoundCents ||
      a.tools.some(x => !b.tools.includes(x)) || a.dataScopes.some(x => !b.dataScopes.includes(x)))
    throw new Error('cultivation_permission_expansion');
}
