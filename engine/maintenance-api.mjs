import { sessionProblem } from './sandbox-api.mjs';
import { DEFAULT_MAINTENANCE_TTL_MS, MAX_MAINTENANCE_TTL_MS, maintenanceDuration } from './maintenance-protocol.mjs';

// Deliberately no executor injection, environment bypass, grant or renewal.
// This phase cannot create a lease or fall back to an unrestricted tool.
export function createMaintenanceApi({ sessionExists }) {
  const unavailable = sessionId => ({
    sessionId, available: false, reason: 'executor_unavailable',
    message: '隔离执行器与本机可信授权入口尚未接入，超维模式不可启用。',
    defaultDurationMs: DEFAULT_MAINTENANCE_TTL_MS,
    maxDurationMs: MAX_MAINTENANCE_TTL_MS, lease: null, engine: 'yuanshu',
  });
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
      const view = unavailable(body.sessionId);
      return { status: 503, body: { ok: false, ...view, error: view.message } };
    },
    revoke(leaseId, body) {
      return sessionProblem(body?.sessionId, sessionExists) || {
        status: 404, body: { ok: false, reason: 'lease_not_found', error: '没有可撤销的维护授权' },
      };
    },
  };
}
