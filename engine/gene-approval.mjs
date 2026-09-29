// Existing confirmation UI, one action per expiring confirmation. Never trust a
// caller-supplied reviewer/approved flag. API authentication still applies.
export function createGeneApproval({ api, registry, sessionExists, push, timeoutMs = 60000 }) {
  const active = new Set();
  function target(action, id) {
    const state = api.getGenome();
    const item = action === 'approve' ? state.proposals.find(p => p.proposal_id === id && p.status === 'pending') : state.snapshots.find(s => s.snapshot_id === id && !s.rolled_back_at);
    if (!item) return null;
    const gene = state.genes[item.gene];
    return { item, baseline: gene?.baseline, revision: gene?.revision ?? null };
  }
  return async (action, body = {}) => {
    const sessionId = body.sessionId;
    if (!['approve', 'rollback'].includes(action) || typeof sessionId !== 'string' || !sessionExists(sessionId)) return { error: '需要有效会话中的人工确认', code: 'confirmation_required' };
    const id = action === 'approve' ? body.proposal_id : body.snapshot_id;
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 2000) : '';
    if (action === 'rollback' && !reason) return { error: '请填写回滚理由' };
    const original = target(action, id);
    if (!original) return { error: '提案或快照不存在或已处理' };
    const key = `${action}:${id}`;
    if (active.has(key)) return { error: '该操作正在等待人工确认' };
    active.add(key);
    let reg;
    try {
      const description = action === 'approve'
        ? `批准人格基因 ${original.item.gene}：${original.baseline} → ${original.item.proposed_baseline}；${original.item.reason || ''}；证据 ${JSON.stringify(original.item.evidence)}`
        : `回滚人格基因 ${original.item.gene}：${original.baseline} → ${original.item.old_baseline}；理由：${reason}`;
      reg = registry.register(sessionId, { toolName: 'gene-governance', reason: description, src: 'gene-governance', action, targetId: id }, timeoutMs);
      push(sessionId, 'confirm', { id: reg.id, sessionId, toolName: 'gene-governance', reason: description, expiresAt: Date.now() + timeoutMs });
      if (await reg.promise !== 'allowed-once') return { error: '人工未批准或确认已过期', code: 'confirmation_denied' };
      if (JSON.stringify(target(action, id)) !== JSON.stringify(original)) return { error: '确认期间目标发生变化，请重新审查', code: 'stale_confirmation' };
      const reviewer = `human-confirm:${sessionId}:${reg.id}`;
      return action === 'approve' ? api.approveProposal(id, reviewer, original) : api.rollbackSnapshot(id, reviewer, reason, original);
    } catch (error) { return { error: error.message, code: 'approval_failed' }; }
    finally { if (reg) registry.settle(sessionId, reg.id, false); active.delete(key); }
  };
}
