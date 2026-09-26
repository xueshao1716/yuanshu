// Pure protocol checks, NOT an authorization service. No production caller may
// treat a client-supplied object or a passing check as proof of a signed grant.
export const DEFAULT_MAINTENANCE_TTL_MS = 60 * 60 * 1000;
export const MAX_MAINTENANCE_TTL_MS = 2 * DEFAULT_MAINTENANCE_TTL_MS;
const BINDINGS = ['leaseId', 'sessionId', 'taskId', 'runId', 'principalId', 'executorId', 'policyVersion', 'epoch', 'actionDigest'];
const TERMINAL = new Set(['expired', 'revoked', 'completed', 'denied']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function maintenanceDuration(value = DEFAULT_MAINTENANCE_TTL_MS) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MAINTENANCE_TTL_MS) throw new Error('invalid_duration');
  return value;
}

export function checkMaintenanceLease(lease, context) {
  const deny = reason => ({ ok: false, reason });
  if (!lease || !context || !nonempty(lease.leaseId)) return deny('invalid_lease');
  if (context.controlPlaneConnected !== true) return deny('control_plane_unavailable');
  if (lease.state !== 'active') return deny(TERMINAL.has(lease.state) ? lease.state : 'not_active');
  for (const key of BINDINGS) {
    if (!nonempty(lease[key]) || lease[key] !== context[key]) return deny('binding_mismatch');
  }
  if (!Number.isSafeInteger(lease.revision) || lease.revision < 1 || lease.revision !== context.revision) return deny('revision_mismatch');
  const { issuedAt, expiresAt } = lease;
  const { now, lastObservedAt } = context;
  if (![issuedAt, expiresAt, now, lastObservedAt].every(Number.isSafeInteger) || issuedAt < 0 || lastObservedAt < issuedAt || now < lastObservedAt || now < issuedAt) return deny('invalid_clock');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MAINTENANCE_TTL_MS) return deny('invalid_duration');
  if (now >= expiresAt) return deny('expired');
  return { ok: true, reason: 'protocol_valid_only' };
}

// Only narrows state. Activation/renewal must live in the future trusted service.
export function closeMaintenanceLease(lease, state) {
  if (!lease || !TERMINAL.has(state)) throw new Error('terminal_transition_required');
  if (TERMINAL.has(lease.state)) return { ...lease };
  if (!['requested', 'active'].includes(lease.state)) throw new Error('invalid_state');
  if (lease.state === 'requested' && !['denied', 'revoked', 'expired'].includes(state)) throw new Error('invalid_transition');
  if (lease.state === 'active' && state === 'denied') throw new Error('invalid_transition');
  if (!Number.isSafeInteger(lease.revision) || lease.revision < 1 || lease.revision === Number.MAX_SAFE_INTEGER) throw new Error('invalid_revision');
  return { ...lease, state, revision: lease.revision + 1 };
}
