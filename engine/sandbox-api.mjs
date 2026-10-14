import { SANDBOX_PRESETS, recordSandboxMode, sandboxModeView } from './sandbox-session.mjs';

export function sessionProblem(sessionId, sessionExists) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId !== sessionId.trim() || sessionId.length > 256) {
    return { status: 400, body: { ok: false, reason: 'session_required', error: '请明确选择会话' } };
  }
  if (!sessionExists(sessionId)) return { status: 404, body: { ok: false, reason: 'session_not_found', error: '会话不存在' } };
  return null;
}

// 沙箱模式全局生效：不再要求选会话。sessionId 可选，仅记入审计（从哪个会话改的）。
export function createSandboxApi({ agentDir }) {
  return {
    get() {
      return { status: 200, body: { ok: true, scope: 'global', ...sandboxModeView(agentDir) } };
    },
    set(body) {
      if (typeof body?.preset !== 'string' || !Object.hasOwn(SANDBOX_PRESETS, body.preset) || (body.reason !== undefined && typeof body.reason !== 'string')) {
        return { status: 400, body: { ok: false, reason: 'invalid_input', error: '预设或理由无效' } };
      }
      const via = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 256) : '';
      const result = recordSandboxMode(agentDir, via, { preset: body.preset, reason: body.reason, origin: 'api' });
      return { status: result.ok ? 200 : 400, body: { ...result, ...(result.ok ? {} : { error: result.reason }), scope: 'global', view: result.ok ? sandboxModeView(agentDir) : null } };
    },
  };
}
