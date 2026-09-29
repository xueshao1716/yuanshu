export function createPersonaApproval({ api, registry, sessionExists, push, timeoutMs = 60000 }) {
  let active = false;
  return async (action, body = {}) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '人格操作请求必须为对象', code: 'invalid_request' };
    const sid = body.sessionId;
    if (typeof sid !== 'string' || !sessionExists(sid)) return { error: '请先选择一个有效会话，以记录人工确认', code: 'confirmation_required' };
    if (active) return { error: '已有一个人格操作等待确认', code: 'confirmation_pending' };
    let reg;
    try {
      const plan = api.prepare(action, body);
      active = true;
      const differences = plan.changed.map(k => `${k}: ${JSON.stringify(plan.before[k])} → ${JSON.stringify(plan.next[k])}`).join('\n');
      const reason = `${action === 'rollback' ? '回退' : '修改'}人格定义\n${differences}\n理由：${plan.reason}`;
      reg = registry.register(sid, { toolName: 'persona-governance', reason, src: 'persona-governance', action }, timeoutMs);
      push(sid, 'confirm', { id: reg.id, sessionId: sid, toolName: 'persona-governance', reason, expiresAt: Date.now() + timeoutMs });
      if (await reg.promise !== 'allowed-once') return { error: '未批准或确认已过期，未修改人格', code: 'confirmation_denied' };
      if (!sessionExists(sid) || JSON.stringify(api.prepare(action, body)) !== JSON.stringify(plan)) return { error: '确认期间人格版本发生变化，请重新审查', code: 'stale_confirmation' };
      return api.commit(plan, `human-confirm:${sid}:${reg.id}`);
    } catch (error) { return { error: error.message, code: 'persona_update_failed' }; }
    finally { if (reg) registry.settle(sid, reg.id, false); active = false; }
  };
}
