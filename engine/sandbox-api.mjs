import { SANDBOX_PRESETS, recordSandboxMode, sandboxModeView } from './sandbox-session.mjs';

export function sessionProblem(sessionId, sessionExists) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId !== sessionId.trim() || sessionId.length > 256) {
    return { status: 400, body: { ok: false, reason: 'session_required', error: '请明确选择会话' } };
  }
  if (!sessionExists(sessionId)) return { status: 404, body: { ok: false, reason: 'session_not_found', error: '会话不存在' } };
  return null;
}

export function createSandboxApi({ agentDir, sessionExists }) {
  return {
    get(sessionId) {
      return sessionProblem(sessionId, sessionExists) || {
        status: 200, body: { ok: true, sessionId, ...sandboxModeView(agentDir, sessionId) },
      };
    },
    set(body) {
      const sessionId = body?.sessionId;
      const problem = sessionProblem(sessionId, sessionExists);
      if (problem) return problem;
      if (typeof body.preset !== 'string' || !Object.hasOwn(SANDBOX_PRESETS, body.preset) || (body.reason !== undefined && typeof body.reason !== 'string')) {
        return { status: 400, body: { ok: false, reason: 'invalid_input', error: '预设或理由无效' } };
      }
      const result = recordSandboxMode(agentDir, sessionId, { preset: body.preset, reason: body.reason, origin: 'api' });
      return { status: result.ok ? 200 : 400, body: { ...result, ...(result.ok ? {} : { error: result.reason }), sessionId, view: result.ok ? sandboxModeView(agentDir, sessionId) : null } };
    },
  };
}
