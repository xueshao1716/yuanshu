// Host-owned, per-attempt capabilities. JSON, request data and run IDs are never
// credentials. Durable eligibility is only a restriction, not an authorization.
export function isMotherExecutionCandidate(body) {
  return body?.origin == null && body?.workflow == null &&
    typeof body?.message === 'string' && !/^\s*\/team(?:\s|$)/i.test(body.message);
}

export function createRunExecutionIdentity({store, executions, instanceId, workspaceScope, now = Date.now}) {
  const records = new WeakMap();
  let disposed = false;
  const workspaceNow = () => {
    try {
      const ws = workspaceScope();
      return typeof ws === 'string' && ws ? ws : null;
    } catch { return null }
  };
  // 2026-10-19：网页直连对话没有 run 上下文，培养工具因此永远拿不到「母体执行身份」。
  // 这里给"本机直连 + 母亲候选"的交互对话签发一个**短时**身份：不绑定 run，
  // 但同样受 disposed / 时钟回拨 / 工作区漂移 / 截止时间四道校验。
  const mintChat = ({ sessionId = '', ttlMs = 30 * 60 * 1000 } = {}) => {
    if (disposed) return null;
    const workspace = workspaceNow();
    if (!workspace) return null;
    const at = now();
    if (!Number.isFinite(at)) return null;
    const source = Object.freeze({});
    const ttl = Math.min(2 * 60 * 60 * 1000, Math.max(60 * 1000, Number(ttlMs) || 30 * 60 * 1000));
    records.set(source, { chat: true, sessionId: String(sessionId || ''), workspace, lastAt: at,
      deadline: at + ttl, motherEligible: true });
    return source;
  };
  const mint = (run, control) => {
    const source = Object.freeze({});
    const at = now();
    let workspace = null;
    try { workspace = workspaceScope(); } catch { /* No scope means no identity. */ }
    records.set(source, {control, runId: run.id, sessionId: run.sessionId,
      attempt: run.checkpoint?.attempt ?? 0, workspace, lastAt: at,
      deadline: control.body.__runContext.executionDeadlineAt,
      motherEligible: run.motherIdentityEligible === true && !run.voiceTaskAdmission && isMotherExecutionCandidate(run.request)});
    Object.defineProperty(control.body.__runContext, 'executionIdentity', {value: source});
  };
  const revoke = control => records.delete(control?.body.__runContext.executionIdentity);
  const resolve = source => {
    const record = records.get(source);
    if (!record) return null;
    try {
      const at = now(), workspace = workspaceNow();
      if (disposed || !Number.isFinite(at) || !Number.isFinite(record.lastAt) ||
          at < record.lastAt || at >= record.deadline ||
          typeof record.workspace !== 'string' || !record.workspace || workspace !== record.workspace) {
        records.delete(source); return null;
      }
      if (record.chat) {
        record.lastAt = at;
        return { runId: null, sessionId: record.sessionId, attempt: 0,
          workspace: record.workspace, motherEligible: true, chat: true };
      }
      const current = store.get(record.runId);
      if (executions.get(record.runId) !== record.control || record.control.stopRequested ||
          current?.status !== 'running' || current.ownerId !== instanceId ||
          current.sessionId !== record.sessionId || current.checkpoint?.attempt !== record.attempt ||
          (record.motherEligible && (current.motherIdentityEligible !== true || current.voiceTaskAdmission ||
            !isMotherExecutionCandidate(current.request)))) {
        records.delete(source); return null;
      }
      record.lastAt = at;
      return {runId: record.runId, sessionId: record.sessionId, attempt: record.attempt,
        workspace: record.workspace, motherEligible: record.motherEligible};
    } catch { records.delete(source); return null; }
  };
  return Object.freeze({mint, mintChat, resolve, revoke, dispose: () => {disposed = true;}});
}
