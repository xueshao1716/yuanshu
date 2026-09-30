// Host-owned, per-attempt capabilities. JSON, request data and run IDs are never
// credentials. Durable eligibility is only a restriction, not an authorization.
export function isMotherExecutionCandidate(body) {
  return body?.origin == null && body?.workflow == null &&
    typeof body?.message === 'string' && !/^\s*\/team(?:\s|$)/i.test(body.message);
}

export function createRunExecutionIdentity({store, executions, instanceId, workspaceScope, now = Date.now}) {
  const records = new WeakMap();
  let disposed = false;
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
      const at = now(), current = store.get(record.runId);
      if (disposed || !Number.isFinite(at) || !Number.isFinite(record.lastAt) ||
          at < record.lastAt || at >= record.deadline ||
          typeof record.workspace !== 'string' || !record.workspace || workspaceScope() !== record.workspace ||
          executions.get(record.runId) !== record.control || record.control.stopRequested ||
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
  return Object.freeze({mint, resolve, revoke, dispose: () => {disposed = true;}});
}
