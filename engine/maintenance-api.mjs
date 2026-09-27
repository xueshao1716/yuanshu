import { randomUUID, createHash } from 'node:crypto';
import { sessionProblem } from './sandbox-api.mjs';
import { DEFAULT_MAINTENANCE_TTL_MS, MAX_MAINTENANCE_TTL_MS, maintenanceDuration } from './maintenance-protocol.mjs';

// Deliberately no executor injection, environment bypass, grant or renewal.
// This phase cannot create a lease or fall back to an unrestricted tool.
export function createMaintenanceApi({ sessionExists, requestApproval = null, now = () => Date.now(), epoch = `boot-${Date.now().toString(36)}` }) {
  const leases = new Map();
  const canApprove = typeof requestApproval === 'function';
  const activeLease = sessionId => {
    const lease = [...leases.values()].find(x => x.sessionId === sessionId && x.state === 'active');
    if (!lease) return null;
    if (now() >= lease.expiresAt) { lease.state = 'expired'; lease.revision += 1; return null; }
    return { ...lease };
  };
  const unavailable = sessionId => ({
    sessionId, available: canApprove, reason: canApprove ? 'awaiting_local_approval' : 'executor_unavailable',
    message: canApprove ? '超维模式已接入本机确认；提交后请在本机确认一次。' : '隔离执行器与本机可信授权入口尚未接入，超维模式不可启用。',
    defaultDurationMs: DEFAULT_MAINTENANCE_TTL_MS,
    maxDurationMs: MAX_MAINTENANCE_TTL_MS, lease: activeLease(sessionId), engine: 'yuanshu',
  });
  const digest = body => `sha256:${createHash('sha256').update(JSON.stringify({ sessionId: body.sessionId, taskId: body.taskId, runId: body.runId })).digest('hex')}`;
  return {
    status(sessionId) {
      return sessionProblem(sessionId, sessionExists) || { status: 200, body: { ok: true, ...unavailable(sessionId) } };
    },
    request(body) {
      const problem = sessionProblem(body?.sessionId, sessionExists);
      if (problem) return problem;
      if (!['taskId', 'runId'].every(key => typeof body[key] === 'string' && body[key].trim() && body[key].length <= 256)) {
        return { status: 400, body: { ok: false, reason: 'task_and_run_required', error: '请指定任务及本次运行编号' } };
      }
      try { maintenanceDuration(body.durationMs); }
      catch { return { status: 400, body: { ok: false, reason: 'invalid_duration', error: '有效期必须大于零且不超过 2 小时' } }; }
      const existing = activeLease(body.sessionId);
      if (existing && existing.taskId === body.taskId && existing.runId === body.runId) return { status: 200, body: { ok: true, available: true, sessionId: body.sessionId, engine: 'yuanshu', lease: existing } };
      if (!canApprove) { const view = unavailable(body.sessionId); return { status: 503, body: { ok: false, ...view, error: view.message } }; }
      return Promise.resolve(requestApproval({ ...body })).then(approved => {
        if (approved !== true && approved !== 'allowed-once') return { status: 403, body: { ok: false, reason: 'approval_denied', error: '本机未批准超维模式，未授予权限。', sessionId: body.sessionId, lease: null } };
        const issuedAt = now();
        const lease = { leaseId: randomUUID(), sessionId: body.sessionId, taskId: body.taskId, runId: body.runId, principalId: 'local-human', executorId: 'yuanshu', policyVersion: 'maintenance-v1', epoch, actionDigest: digest(body), revision: 1, state: 'active', issuedAt, expiresAt: issuedAt + maintenanceDuration(body.durationMs) };
        leases.set(lease.leaseId, lease);
        return { status: 200, body: { ok: true, available: true, sessionId: body.sessionId, engine: 'yuanshu', lease } };
      });
    },
    revoke(leaseId, body) {
      const problem = sessionProblem(body?.sessionId, sessionExists); if (problem) return problem;
      const lease = leases.get(leaseId);
      if (!lease || lease.sessionId !== body.sessionId || lease.state !== 'active') return { status: 404, body: { ok: false, reason: 'lease_not_found', error: '没有可撤销的维护授权' } };
      lease.state = 'revoked'; lease.revision += 1;
      return { status: 200, body: { ok: true, lease: { ...lease } } };
    },
    hasLease({ sessionId, taskId, runId } = {}) {
      const lease = activeLease(sessionId);
      return !!(lease && lease.taskId === taskId && lease.runId === runId);
    },
  };
}
