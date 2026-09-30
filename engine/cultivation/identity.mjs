import {createHash} from 'node:crypto';
import {clonePayload} from './state.mjs';

const fail = code => { throw new Error(`cultivation_identity_${code}`); };
const label = v => typeof v === 'string' && v.trim() === v && v.length > 0 &&
  v.length <= 120 && !/[\x00-\x1f]/.test(v);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const commandHash = command => createHash('sha256')
  .update(canonical(clonePayload(command))).digest('hex');

// Only the trusted host may install resolvers. A bearer, local Origin or caller
// supplied actor is NOT a resolver. No principal is serializable or transferable.
export function createIdentityAuthority({workspace, resolveHuman, resolveMother,
  now = Date.now, ttlMs = 30000}) {
  if (!/^[a-f0-9]{64}$/.test(workspace) || !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 || ttlMs > 60000) fail('denied');
  const principals = new WeakMap();
  const resolvers = {human: resolveHuman, mother: resolveMother};
  const resolve = (kind, source, hash) => {
    const resolver = Object.hasOwn(resolvers, kind) && resolvers[kind];
    if (typeof resolver !== 'function') fail('unavailable');
    const value = resolver(source, Object.freeze({workspace, commandHash: hash, kind}));
    if (value instanceof Promise) { value.catch(() => {}); fail('denied'); }
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('denied');
    const identity = clonePayload(value);
    if (Object.keys(identity).length !== 2 || !label(identity.actorId) ||
        !label(identity.originId)) fail('denied');
    return identity;
  };
  const issue = (kind, source, command) => {
    const hash = commandHash(command), at = now();
    if (!Number.isFinite(at)) fail('expired');
    const identity = resolve(kind, source, hash);
    const principal = Object.freeze({});
    principals.set(principal, {source, identity, kind, hash, at});
    return principal;
  };
  const assert = (principal, command, allowedKinds) => {
    const record = principals.get(principal);
    if (!record || !allowedKinds.includes(record.kind) || record.hash !== commandHash(command)) fail('denied');
    const at = now();
    if (!Number.isFinite(at) || at < record.at || at >= record.at + ttlMs) fail('expired');
    const current = resolve(record.kind, record.source, record.hash);
    if (current.actorId !== record.identity.actorId || current.originId !== record.identity.originId) fail('denied');
    return Object.freeze({...current, kind: record.kind, workspace, commandHash: record.hash});
  };
  return Object.freeze({issue, assert});
}
