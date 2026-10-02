import {randomUUID} from 'node:crypto';
import {commandHash} from './identity.mjs';

const fail = code => { throw new Error(`cultivation_identity_${code}`); };
const label = value => typeof value === 'string' && value.trim() === value && value.length > 0 &&
  value.length <= 120 && !/[\x00-\x1f]/.test(value);

// A session grant is deliberately narrower than a human/device grant. It is
// created by an authenticated current session, bound to one exact command,
// and consumed once. It never grants computer, file-system, model, or tool
// access; the command allow-list is the final boundary.
export function createSessionGrants({workspace, host, now = Date.now, ttlMs = 60000,
  allowedActions = ['policy.set']}) {
  if (!/^[a-f0-9]{64}$/.test(workspace) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60000 ||
      !Array.isArray(allowedActions) || allowedActions.some(action => !label(action))) fail('unavailable');
  const challenges = new Map();
  const proofs = new Map();
  const sources = new WeakMap();
  let epoch = 0;
  const available = typeof host?.canAccess === 'function' && typeof host?.push === 'function' &&
    typeof host?.registry?.register === 'function' && typeof host?.registry?.settle === 'function';
  const accessible = sessionId => {
    if (!available || !label(sessionId)) return false;
    try { return host.canAccess(sessionId) === true; } catch { return false; }
  };
  const fresh = row => row.epoch === epoch && Number.isFinite(now()) &&
    now() >= row.createdAt && now() < row.expiresAt;
  const cancel = row => host.registry.settle(row.sessionId, row.id, false);
  const clean = () => {
    for (const [id, row] of challenges) if (!fresh(row)) {cancel(row); challenges.delete(id);}
    for (const [token, row] of proofs) if (!fresh(row)) proofs.delete(token);
  };
  const validateSession = sessionId => {
    if (!available) fail('unavailable');
    if (!accessible(sessionId)) fail('denied');
  };
  const challenge = (command, sessionId) => {
    validateSession(sessionId); clean();
    if (!command || !allowedActions.includes(command.action)) fail('denied');
    if (challenges.size + proofs.size >= 128 || !Number.isFinite(now()) ||
        [...challenges.values()].some(row => row.sessionId === sessionId)) fail('denied');
    const createdAt = now(), row = {id: randomUUID(), sessionId, commandHash: commandHash(command),
      createdAt, expiresAt: createdAt + ttlMs, epoch};
    const payload = {id:row.id, toolName:'cultivation-policy', src:'cultivation-policy',
      reason:`确认本次培养策略（不授权电脑操作或其他系统权限）：${JSON.stringify(command.payload.policy)}`};
    const reg = host.registry.register(sessionId, payload, ttlMs);
    row.promise = reg.promise.then(outcome => {
      // A declined/closed dialog never asks for a proof. Release it here so
      // the same session can retry immediately without waiting for the TTL.
      if (outcome !== 'allowed-once') challenges.delete(row.id);
      return outcome;
    });
    challenges.set(row.id, row);
    try {host.push(sessionId, 'confirm', {...payload, sessionId, expiresAt:row.expiresAt});}
    catch {cancel(row); challenges.delete(row.id); fail('unavailable');}
    return Object.freeze({id: row.id, sessionId, commandHash: row.commandHash, expiresAt: row.expiresAt});
  };
  const confirm = async (id, command, sessionId) => {
    validateSession(sessionId); clean();
    const row = challenges.get(id);
    if (!row || row.claimed || row.sessionId !== sessionId || row.commandHash !== commandHash(command) || !fresh(row)) fail('denied');
    row.claimed = true;
    const hash = commandHash(command);
    const outcome = await row.promise;
    challenges.delete(id);
    if (outcome !== 'allowed-once' || !fresh(row) || !accessible(sessionId) || hash !== commandHash(command)) fail('denied');
    const token = randomUUID();
    const {promise:unused, ...verified} = row;
    proofs.set(token, {...verified, token});
    return Object.freeze({id, sessionId, token, expiresAt: row.expiresAt});
  };
  return Object.freeze({
    available,
    challenge,
    confirm,
    verify: (proof, command, sessionId) => {
      validateSession(sessionId); clean();
      if (!proof || Object.getPrototypeOf(proof) !== Object.prototype ||
          Object.keys(proof).length !== 4 || typeof proof.id !== 'string' ||
          typeof proof.sessionId !== 'string' || typeof proof.token !== 'string' ||
          proof.sessionId !== sessionId) fail('denied');
      const row = proofs.get(proof.token);
      if (!row || row.id !== proof.id || row.sessionId !== sessionId || proof.expiresAt !== row.expiresAt ||
          row.commandHash !== commandHash(command) || !fresh(row)) fail('denied');
      proofs.delete(proof.token);
      const source = Object.freeze({});
      sources.set(source, row);
      return source;
    },
    resolveHuman: (source, context) => {
      const row = sources.get(source);
      return row && fresh(row) && accessible(row.sessionId) && context?.workspace === workspace && context?.kind === 'human' &&
        context.commandHash === row.commandHash
        ? {actorId: 'session-confirmed-user', originId: `session-grant:${row.id}`} : null;
    },
    revoke: () => { epoch++; for (const row of challenges.values()) cancel(row); challenges.clear(); proofs.clear(); },
  });
}
